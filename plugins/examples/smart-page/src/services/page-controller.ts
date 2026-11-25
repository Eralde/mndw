import {
  BackendDisabled,
  BackendError,
  BackendNotApproved,
  BackendStarting,
  BackendUnavailable,
  BackendUnknownId,
} from '@mndw/sdk';
import type {Device, DeviceTypeOverride, Operation, Snapshot} from '../model/api';
import {SmartApiError, type SmartClientApi} from './smart-client';
import {WAKE_CONSENT_PREFIX, type WakeConsentStorage, wakeConsentKey} from './wake-consent';

export type BackendAvailability =
  | 'unknown'
  | 'available'
  | 'unknown-id'
  | 'not-approved'
  | 'disabled'
  | 'starting'
  | 'unavailable'
  | 'incompatible';

export type PageNotice =
  | {kind: 'backend-recovered'}
  | {kind: 'device-not-selected'}
  | {kind: 'busy'; code: string}
  | {kind: 'disconnected'; code: string; requiredAction: 'discover'}
  | {kind: 'request-error'; code: string};

/** Why the device list is empty; null while it has devices or no snapshot has arrived. */
export type EmptyState =
  | {kind: 'searching'}
  | {kind: 'no-utility'}
  | {kind: 'failed'; code: string}
  | {kind: 'nothing-found'}
  | {kind: 'never-ran'};

export interface PageState {
  selectedDeviceId: string | null;
  snapshot: Snapshot | null;
  operation: Operation | null;
  backendAvailability: BackendAvailability;
  notice: PageNotice | null;
  wakeConsentGranted: boolean;
  wakeConsentKeys: ReadonlySet<string>;
  /** The selected drive needs the one-time wake confirmation before a manual read. */
  wakeConfirmationRequired: boolean;
  /** One reason for the empty device list, derived here so every view agrees on it. */
  emptyState: EmptyState | null;
}

export interface PageControllerOptions {
  wakeConsentStorage?: WakeConsentStorage;
  onDiscoverAccepted?: () => void;
}

export type ActionResult = 'accepted' | 'rejected';

type ReadIntent = 'snapshot' | 'operation';
type TimerHandle = ReturnType<typeof setTimeout>;

class StaleActionTarget extends Error {}

/** The discovery the controller started or is following; the wire snapshot cannot tell a started scan apart. */
interface DiscoveryProgress {
  phase: 'idle' | 'running' | 'failed';
  failureCode: string | null;
  /** Snapshot reads spent on a scan someone else started (a busy reply); null while we follow our own operation. */
  unfollowedPolls: number | null;
}

const IDLE_DISCOVERY: DiscoveryProgress = {phase: 'idle', failureCode: null, unfollowedPolls: null};

const CACHE_POLL_MS = 30_000,
  OPERATION_POLL_MS = 1_000,
  UNFOLLOWED_POLL_LIMIT = 120,
  RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000] as const;

export class PageController {
  private readonly client: SmartClientApi;
  private readonly options: PageControllerOptions;
  private readonly listeners = new Set<(state: PageState) => void>();
  private state: PageState = {selectedDeviceId: null, snapshot: null, operation: null, backendAvailability: 'unknown',
    notice: null, wakeConsentGranted: false, wakeConsentKeys: new Set(), wakeConfirmationRequired: false,
    emptyState: null};
  private discovery: DiscoveryProgress = IDLE_DISCOVERY;
  private mounted = false;
  private visible = true;
  private generation = 0;
  private activeOperationId: string | null = null;
  private pendingAction = false;
  private actionSequence = 0;
  private activeRequest: AbortController | null = null;
  private requestQueue: Promise<void> = Promise.resolve();
  private readonly reads: Record<ReadIntent, {dueAt: number | null; retryAttempt: number}> = {
    snapshot: {dueAt: null, retryAttempt: 0},
    operation: {dueAt: null, retryAttempt: 0},
  };
  private schedulerTimer: TimerHandle | null = null;
  private resumeOperationAfterSnapshot = false;
  private autoDiscoveryAttempted = false;

  constructor(client: SmartClientApi, options: PageControllerOptions = {}) {
    this.client = client;
    this.options = options;
  }

  public getState(): PageState {
    return this.state;
  }

  public subscribe(listener: (state: PageState) => void): () => void {
    listener(this.state);
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public start(): void {
    if (this.mounted) { return; }

    this.mounted = true;
    this.autoDiscoveryAttempted = false;
    void this.loadWakeConsent();

    if (this.visible) {
      this.snapshotThenResume();
    }
  }

  public stop(): void {
    if (!this.mounted) { return; }

    this.mounted = false;
    this.dropUnfollowedDiscovery();

    if (this.state.wakeConsentGranted) {
      this.replaceState({...this.state, wakeConsentGranted: false});
    }

    this.invalidateReadWork();
  }

  public setVisible(visible: boolean): void {
    if (!this.mounted || this.visible === visible) { return; }

    this.visible = visible;

    if (visible) {
      this.snapshotThenResume();

      return;
    }

    this.invalidateReadWork();
  }

  public selectDevice(id: string): void {
    if (!this.isActive() || this.state.selectedDeviceId === id) { return; }

    this.commitState({selectedDeviceId: id}, () => {
      this.snapshotThenResume();
    });
  }

  public async discover(targetDeviceId?: string): Promise<ActionResult> {
    if (!this.isActive()) { return 'rejected'; }

    if (targetDeviceId !== undefined && targetDeviceId !== this.state.selectedDeviceId) { return 'rejected'; }

    return this.runDiscover(false);
  }

  public async refresh(
    acknowledgeWake: boolean,
    targetDeviceId?: string,
    rememberConsent = false,
  ): Promise<ActionResult> {
    if (!this.isActive()) { return 'rejected'; }

    const deviceId = targetDeviceId ?? this.state.selectedDeviceId;

    if (deviceId === null) {
      this.commitState({notice: {kind: 'device-not-selected'}});

      return 'rejected';
    }

    if (deviceId !== this.state.selectedDeviceId) { return 'rejected'; }

    const device = this.state.snapshot?.devices.find((item) => item.deviceId === deviceId);
    const confirmationNeeded = this.wakeConfirmationRequiredFor(deviceId, this.state);

    if (!acknowledgeWake && confirmationNeeded) { return 'rejected'; }

    return this.submitOperation(
      (signal) => {
        return this.client.refresh(deviceId, true, signal);
      },
      deviceId,
      acknowledgeWake && confirmationNeeded,
      rememberConsent && acknowledgeWake && confirmationNeeded && device !== undefined
        ? () => {
          return this.storeWakeConsent(device);
        }
        : undefined,
    );
  }

  public async setDeviceType(
    deviceType: DeviceTypeOverride | null,
    targetDeviceId?: string,
  ): Promise<ActionResult> {
    if (!this.isActive()) { return 'rejected'; }

    const deviceId = targetDeviceId ?? this.state.selectedDeviceId;

    if (deviceId === null) {
      this.commitState({notice: {kind: 'device-not-selected'}});

      return 'rejected';
    }

    if (deviceId !== this.state.selectedDeviceId) { return 'rejected'; }

    return this.runAction(
      (signal) => {
        return this.client.setDeviceType(deviceId, deviceType, signal);
      },
      () => {
        return this.commitState({notice: this.actionStartNotice()}, () => {
          return this.runIntentNow('snapshot');
        });
      },
      deviceId,
    );
  }

  private async submitOperation(
    submit: (signal: AbortSignal) => ReturnType<SmartClientApi['discover']>,
    targetDeviceId?: string,
    grantWakeConsent = false,
    persistWakeConsent?: () => Promise<void>,
    silent = false,
  ): Promise<ActionResult> {
    return this.runAction(
      submit,
      async (accepted) => {
        this.activeOperationId = accepted.operationId;
        this.reads.operation.retryAttempt = 0;

        this.commitState({operation: null, notice: this.actionStartNotice(),
          ...(grantWakeConsent ? {wakeConsentGranted: true} : {})}, () => {
          this.runIntentNow('operation');
        });

        await persistWakeConsent?.();
      },
      targetDeviceId,
      silent,
    );
  }

  private async runAction<T>(
    submit: (signal: AbortSignal) => Promise<T>,
    onSuccess: (value: T) => Promise<void> | void,
    targetDeviceId?: string,
    silent = false,
  ): Promise<ActionResult> {
    if (!this.isActive() || this.pendingAction) {
      return 'rejected';
    }

    if (targetDeviceId !== undefined && this.state.selectedDeviceId !== targetDeviceId) { return 'rejected'; }

    this.pendingAction = true;

    const actionSequence = ++this.actionSequence;
    const generation = this.generation;

    this.commitState({notice: this.actionStartNotice()});

    try {
      const value = await this.enqueueRequest(generation, (signal) => {
        if (targetDeviceId !== undefined && this.state.selectedDeviceId !== targetDeviceId) {
          return Promise.reject(new StaleActionTarget());
        }

        return submit(signal);
      });

      if (value === null || !this.isCurrent(generation)) {
        return 'rejected';
      }

      await onSuccess(value);

      if (!this.isCurrent(generation)) { return 'rejected'; }

      if (targetDeviceId !== undefined && this.state.selectedDeviceId !== targetDeviceId) {
        return 'rejected';
      }

      return 'accepted';
    } catch (error) {
      if (error instanceof StaleActionTarget) { return 'rejected'; }

      if (!silent && this.isCurrent(generation)) {
        this.handleActionError(error);
      }

      return 'rejected';
    } finally {
      if (actionSequence === this.actionSequence) {
        this.pendingAction = false;
      }
    }
  }

  private async runDiscover(silent: boolean): Promise<ActionResult> {
    if (!this.isActive() || this.pendingAction) { return 'rejected'; }

    let rejection: unknown = null;
    const generation = this.generation;

    this.discovery = {phase: 'running', failureCode: null, unfollowedPolls: null};
    this.commitState({});

    const result = await this.submitOperation(
      async (signal) => {
        try {
          return await this.client.discover(true, signal);
        } catch (error) {
          rejection = error;

          throw error;
        }
      },
      undefined,
      false,
      undefined,
      silent,
    );

    if (result === 'accepted') {
      this.options.onDiscoverAccepted?.();
    } else if (!this.isActive()) {
      this.discovery = IDLE_DISCOVERY;
      this.replaceState(this.state);

      if (silent) {
        // A hidden tab or unmount aborts the queued POST; retry the only automatic attempt when the page returns.
        this.autoDiscoveryAttempted = false;
      }
    } else if (rejection instanceof SmartApiError && rejection.code === 'busy') {
      // A scan is already running that this page did not start: follow it through the snapshot.
      this.discovery = {phase: 'running', failureCode: null, unfollowedPolls: 0};
      this.commitState({}, () => {
        this.setIntent('snapshot', OPERATION_POLL_MS);
        this.scheduleNextIntent();
      });
    } else {
      // A request that a newer read cycle aborted or that a terminal backend refused is not a failed search.
      const refused = rejection !== null && this.generation === generation
        && !this.backendErrorState(rejection).terminal;

      this.discovery = refused
        ? {phase: 'failed', failureCode: this.errorCode(rejection), unfollowedPolls: null}
        : IDLE_DISCOVERY;
      this.commitState({});
    }

    return result;
  }

  private maybeAutoDiscover(snapshot: Snapshot): void {
    if (this.autoDiscoveryAttempted || !this.isActive()) { return; }

    if (!snapshot.diagnostics.reasons.includes('discovery-not-run')) { return; }

    if (!snapshot.diagnostics.utility.available) { return; }

    if (this.operationInProgress()) { return; }

    this.autoDiscoveryAttempted = true;
    void this.runDiscover(true);
  }

  private operationInProgress(): boolean {
    const status = this.state.operation?.status;

    return this.pendingAction || this.activeOperationId !== null || status === 'queued' || status === 'running';
  }

  private async loadWakeConsent(): Promise<void> {
    const storage = this.options.wakeConsentStorage;

    if (storage === undefined) { return; }

    let keys: ReadonlySet<string>;

    try {
      const stored = await storage.keys();

      keys = new Set(stored.filter((key) => {
        return key.startsWith(WAKE_CONSENT_PREFIX);
      }));
    } catch {
      keys = new Set();
    }

    this.applyWakeConsentKeys(keys);
  }

  private async storeWakeConsent(device: Device): Promise<void> {
    const key = wakeConsentKey(device.sample);
    const storage = this.options.wakeConsentStorage;

    if (key === null || storage === undefined) { return; }

    try {
      await storage.set(key, '1');
    } catch {
      return;
    }

    this.applyWakeConsentKeys(new Set([...this.state.wakeConsentKeys, key]));
  }

  private applyWakeConsentKeys(keys: ReadonlySet<string>): void {
    if (this.isActive()) {
      this.commitState({wakeConsentKeys: keys});

      return;
    }

    this.replaceState({...this.state, wakeConsentKeys: keys});
  }

  /** Single consent rule for both the controller action gate and the UI. */
  private wakeConfirmationRequiredFor(deviceId: string | null, state: PageState): boolean {
    if (deviceId === null) { return false; }

    const device = state.snapshot?.devices.find((item) => item.deviceId === deviceId);
    const sample = device?.sample ?? null;

    if (device === undefined || sample === null) { return !state.wakeConsentGranted; }

    if (sample.protocol === 'nvme' || sample.rotationRate === 0) { return false; }

    if (state.wakeConsentGranted) { return false; }

    const key = wakeConsentKey(sample);

    return key === null ? true : !state.wakeConsentKeys.has(key);
  }

  private replaceState(state: PageState): void {
    this.state = {
      ...state,
      wakeConfirmationRequired: this.wakeConfirmationRequiredFor(state.selectedDeviceId, state),
      emptyState: this.emptyStateFor(state),
    };
  }

  private emptyStateFor(state: PageState): EmptyState | null {
    const snapshot = state.snapshot;

    if (snapshot === null || snapshot.devices.length > 0) { return null; }

    if (this.discovery.phase === 'running') { return {kind: 'searching'}; }

    if (!snapshot.diagnostics.utility.available) { return {kind: 'no-utility'}; }

    if (this.discovery.phase === 'failed') {
      return {kind: 'failed', code: this.discovery.failureCode ?? 'request-failed'};
    }

    return {kind: snapshot.diagnostics.reasons.includes('discovery-not-run') ? 'never-ran' : 'nothing-found'};
  }

  /**
   * A finished scan keeps the list in its searching state until the snapshot after it has been read. A scan we do not
   * follow ends when the snapshot shows its result, or after a bounded number of reads.
   */
  private settleDiscovery(snapshot: Snapshot): void {
    const {phase, unfollowedPolls} = this.discovery;

    if (phase !== 'running' || this.pendingAction || this.activeOperationId !== null) { return; }

    if (unfollowedPolls === null) {
      this.discovery = IDLE_DISCOVERY;

      return;
    }

    const finished = snapshot.devices.length > 0 || !snapshot.diagnostics.reasons.includes('discovery-not-run')
      || unfollowedPolls >= UNFOLLOWED_POLL_LIMIT;

    this.discovery = finished ? IDLE_DISCOVERY : {...this.discovery, unfollowedPolls: unfollowedPolls + 1};
  }

  /** A scan we do not follow is forgotten with the page; hiding the tab only pauses the polling. */
  private dropUnfollowedDiscovery(): void {
    if (this.discovery.unfollowedPolls !== null) {
      this.discovery = IDLE_DISCOVERY;
      this.replaceState(this.state);
    }
  }

  private backendWasDown(): boolean {
    return this.state.backendAvailability === 'unavailable' || this.state.backendAvailability === 'starting';
  }

  private snapshotThenResume(): void {
    this.invalidateReadWork();
    this.resumeOperationAfterSnapshot = true;
    this.setIntent('snapshot', 0);
    this.scheduleNextIntent();
  }

  private runIntentNow(intent: ReadIntent): Promise<void> {
    this.reads[intent].dueAt = Date.now();
    this.clearSchedulerTimer();

    return this.dispatchDueIntent();
  }

  private async dispatchDueIntent(): Promise<void> {
    if (!this.isActive()) { return; }

    const intent = this.nextIntent();

    if (intent === null) { return; }

    this.reads[intent].dueAt = null;

    return intent === 'snapshot' ? this.readSnapshot() : this.readOperation();
  }

  private readSnapshot(): Promise<void> {
    return this.readIntent('snapshot', (signal) => {
      return this.client.snapshot(signal);
    }, (snapshot) => {
      const selectedDeviceId = this.state.selectedDeviceId
        ?? (snapshot.devices.length === 1 ? snapshot.devices[0]?.deviceId ?? null : null);
      const recovered = this.backendWasDown();

      this.settleDiscovery(snapshot);
      this.commitState({snapshot, selectedDeviceId, ...this.successfulReadState()}, () => {
        if (recovered) {
          this.autoDiscoveryAttempted = false;
        }

        this.setIntent('snapshot', this.discovery.unfollowedPolls === null ? CACHE_POLL_MS : OPERATION_POLL_MS);

        if (this.resumeOperationAfterSnapshot) {
          this.resumeOperationAfterSnapshot = false;

          if (this.activeOperationId !== null) {
            this.setIntent('operation', 0);
          }
        }

        this.scheduleNextIntent();
        this.maybeAutoDiscover(snapshot);
      });
    });
  }

  private readOperation(): Promise<void> {
    const id = this.activeOperationId;

    if (id === null) { return Promise.resolve(); }

    return this.readIntent('operation', (signal) => {
      return this.client.operation(id, signal);
    }, (operation) => {
      const recovered = this.backendWasDown();

      if (operation.kind === 'discover' && operation.status === 'failed') {
        this.discovery = {phase: 'failed', failureCode: operation.error?.code ?? 'request-failed',
          unfollowedPolls: null};
      }

      this.commitState({operation, ...this.successfulReadState()}, () => {
        if (recovered) {
          this.autoDiscoveryAttempted = false;
        }

        if (operation.status === 'queued' || operation.status === 'running') {
          this.setIntent('operation', OPERATION_POLL_MS);
        } else {
          this.activeOperationId = null;
          this.setIntent('snapshot', 0);
        }

        this.scheduleNextIntent();
      });
    }, (error) => {
      if (error instanceof SmartApiError && error.status === 404 && error.code === 'unknown-operation') {
        this.commitState({operation: null}, () => {
          this.activeOperationId = null;
          this.setIntent('snapshot', 0);
          this.scheduleNextIntent();
        });

        return true;
      }

      return false;
    });
  }

  private async readIntent<T>(
    intent: ReadIntent,
    request: (signal: AbortSignal) => Promise<T>,
    onSuccess: (value: T) => void,
    onError?: (error: unknown) => boolean,
  ): Promise<void> {
    const generation = this.generation;

    try {
      const value = await this.enqueueRequest(generation, request);

      if (value === null) { return; }

      this.reads[intent].retryAttempt = 0;
      onSuccess(value);
    } catch (error) {
      if (this.isCurrent(generation) && onError?.(error) !== true) {
        this.handleGetError(error, intent);
      }
    }
  }

  private handleActionError(error: unknown): void {
    const {availability, terminal} = this.backendErrorState(error);
    const notice: PageNotice =
      error instanceof SmartApiError && error.status === 409 && (error.code === 'busy' || error.code === 'disconnected')
        ? error.code === 'busy'
          ? {kind: 'busy', code: error.code}
          : {kind: 'disconnected', code: error.code, requiredAction: 'discover'}
        : {kind: 'request-error', code: this.errorCode(error)};
    const patch: Partial<PageState> = {notice, ...(availability === null ? {} : {backendAvailability: availability})};

    this.commitState(patch, () => {
      if (terminal) { this.invalidateReadWork(); }
    });
  }

  private successfulReadState(): Pick<PageState, 'backendAvailability' | 'notice'> {
    return {
      backendAvailability: 'available',
      notice: this.backendWasDown() ? {kind: 'backend-recovered'} : null,
    };
  }

  private actionStartNotice(): PageNotice | null {
    return this.state.notice?.kind === 'backend-recovered' ? this.state.notice : null;
  }

  private handleGetError(error: unknown, intent: ReadIntent): void {
    const {availability, terminal} = this.backendErrorState(error, true);

    if (terminal) {
      this.discovery = IDLE_DISCOVERY;
    }

    this.commitState({
      backendAvailability: availability ?? 'unavailable',
      notice: {kind: 'request-error', code: this.errorCode(error)},
    }, () => {
      if (terminal) {
        this.invalidateReadWork();
      } else {
        const read = this.reads[intent];
        const delay = RETRY_DELAYS_MS[Math.min(read.retryAttempt, RETRY_DELAYS_MS.length - 1)];

        read.retryAttempt += 1;
        this.setIntent(intent, delay);
      }

      this.scheduleNextIntent();
    });
  }

  private setIntent(intent: ReadIntent, delayMs: number): void {
    this.reads[intent].dueAt = Date.now() + delayMs;
  }

  private scheduleNextIntent(): void {
    this.clearSchedulerTimer();

    if (!this.isActive()) { return; }

    const intent = this.nextIntent();

    if (intent === null) { return; }

    const dueAt = this.reads[intent].dueAt ?? Number.POSITIVE_INFINITY;
    const delay = Math.max(0, dueAt - Date.now());

    if (delay === 0) {
      void this.dispatchDueIntent();

      return;
    }

    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null;
      void this.dispatchDueIntent();
    }, delay);
  }

  private nextIntent(): ReadIntent | null {
    const snapshotDue = this.reads.snapshot.dueAt;
    const operationDue = this.reads.operation.dueAt;

    if (snapshotDue === null) {
      return operationDue === null ? null : 'operation';
    }

    return operationDue === null || snapshotDue <= operationDue ? 'snapshot' : 'operation';
  }

  private clearSchedulerTimer(): void {
    if (this.schedulerTimer !== null) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private clearReadIntents(): void {
    this.reads.snapshot.dueAt = null;
    this.reads.operation.dueAt = null;
    this.clearSchedulerTimer();
  }

  private enqueueRequest<T>(generation: number, request: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const result = this.requestQueue.then(async (): Promise<T | null> => {
      if (!this.isCurrent(generation)) { return null; }

      const abortController = new AbortController();

      this.activeRequest = abortController;

      try {
        const value = await request(abortController.signal);

        return this.isCurrent(generation) ? value : null;
      } finally {
        if (this.activeRequest === abortController) {
          this.activeRequest = null;
        }
      }
    });

    this.requestQueue = result.then(() => {
      return undefined;
    }, () => {
      return undefined;
    });

    return result;
  }

  private invalidateReadWork(): void {
    this.generation += 1;
    this.actionSequence += 1;
    this.pendingAction = false;
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.clearReadIntents();
  }

  private isActive(): boolean {
    return this.mounted && this.visible;
  }

  private isCurrent(generation: number): boolean {
    return this.isActive() && this.generation === generation;
  }

  private commitState<T = void>(patch: Partial<PageState>, prepare?: () => T): T | undefined {
    if (!this.isActive()) { return undefined; }

    this.replaceState({...this.state, ...patch});

    const prepared = prepare?.();

    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }

    return prepared;
  }

  private backendErrorState(
    error: unknown,
    isRead = false,
  ): {availability: BackendAvailability | null; terminal: boolean} {
    if (error instanceof BackendUnknownId) { return {availability: 'unknown-id', terminal: true}; }

    if (error instanceof BackendNotApproved) { return {availability: 'not-approved', terminal: true}; }

    if (error instanceof BackendDisabled) { return {availability: 'disabled', terminal: true}; }

    if (error instanceof BackendStarting || error instanceof BackendUnavailable) {
      return {availability: error instanceof BackendStarting ? 'starting' : 'unavailable', terminal: false};
    }

    if (error instanceof BackendError) {
      return {availability: error.retryable ? 'unavailable' : 'incompatible', terminal: !error.retryable};
    }

    return {
      availability: isRead || (error instanceof SmartApiError && error.status >= 500) ? 'unavailable' : null,
      terminal: false,
    };
  }

  private errorCode(error: unknown): string {
    if (error instanceof SmartApiError) { return error.code; }

    if (error instanceof BackendError) { return error.code.toLowerCase().replaceAll('_', '-'); }

    return 'request-failed';
  }
}
