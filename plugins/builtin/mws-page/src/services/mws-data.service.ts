import {DestroyRef, Injectable, type Signal, computed, inject, signal} from '@angular/core';
import type {LoadState} from '@mndw/sdk';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {
  ReplaySubject,
  Subject,
  type Subscription,
  catchError,
  defer,
  exhaustMap,
  filter,
  finalize,
  forkJoin,
  fromEvent,
  map,
  merge,
  of,
  timer,
} from 'rxjs';
import {MwsApiService} from '../api/mws-api.service';
import type {ControllerTelemetry} from '../api/controller-telemetry';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from '../api/rci.types';
import {buildMap} from '../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../domain/mws/mws.types';
import {DEVICE_INFO, MWSD_BACKEND} from '../tokens';
import {
  type ExtraFeaturesAvailability,
  type ExtraFeaturesPresentation,
  type ExtraFeaturesSetupReason,
  MwsdStatusService,
} from './mwsd-status.service';

export {
  EXTRA_FEATURES_STARTING_TIMEOUT_MS,
  type ExtraFeaturesAvailability,
  type ExtraFeaturesPresentation,
  type ExtraFeaturesSetupReason,
  MWSD_STATUS_POLL_INTERVAL_MS,
  MWSD_STATUS_REQUEST_TIMEOUT_MS,
} from './mwsd-status.service';

export const POLL_INTERVAL_MS = 3_000;

export type MwsViewPhase = 'loading' | 'error' | 'unsupported' | 'ready';

export interface MwsRequestError {
  message: string;
}

type PollResult =
  | {
    kind: 'ok';
    members: MwsMemberRecord[];
    hosts: DeviceHostRecord[];
    bridge: BridgeInterfaceRecord;
    controllerName: string | null;
    controllerTelemetry: ControllerTelemetry | null;
  }
  | {kind: 'unsupported'; reason: string}
  | {kind: 'error'; error: MwsRequestError};

@Injectable()
export class MwsDataService {
  private readonly api = inject(MwsApiService);
  private readonly deviceInfo = inject(DEVICE_INFO);
  private readonly backend = inject(MWSD_BACKEND);
  private readonly statusService = inject(MwsdStatusService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly loadState = signal<LoadState<MwsNode[], MwsRequestError>>({status: 'loading'});
  public readonly extraFeaturesAvailability: Signal<ExtraFeaturesAvailability> =
    this.statusService.extraFeaturesAvailability;
  public readonly extraFeaturesPresentation: Signal<ExtraFeaturesPresentation> =
    this.statusService.extraFeaturesPresentation;
  public readonly extraFeaturesSetupReasons: Signal<ExtraFeaturesSetupReason[]> =
    this.statusService.extraFeaturesSetupReasons;
  public readonly phase = computed<MwsViewPhase>(() => {
    const state = this.loadState();

    if (state.status === 'unsupported') {
      return 'unsupported';
    }

    if (state.status === 'error' && state.data === undefined) {
      return 'error';
    }

    if (
      state.status === 'success'
      || state.status === 'refreshing'
      || (state.status === 'error' && state.data !== undefined)
    ) {
      return 'ready';
    }

    return 'loading';
  });

  public readonly roots = computed<MwsNode[]>(() => {
    const state = this.loadState();

    if (state.status === 'success' || state.status === 'refreshing') {
      return state.data;
    }

    if (state.status === 'error') {
      return state.data ?? [];
    }

    return [];
  });

  public readonly pollError = computed<boolean>(() => {
    const state = this.loadState();

    return state.status === 'error' && state.data !== undefined;
  });

  public readonly lastUpdatedAt = signal<number | null>(null);
  public readonly freshnessNow = signal(Date.now());

  private readonly snapshotSubject = new ReplaySubject<MwsNode[]>(1);
  public readonly snapshots$ = this.snapshotSubject.asObservable();

  private version: ShowVersionRecord | null = null;
  private versionSub: Subscription | null = null;
  private pollSub: Subscription | null = null;
  private readonly refreshTrigger = new Subject<void>();
  private refreshTimerSub: Subscription | null = null;
  private pollingStarted = false;
  private pollInFlight = false;
  private refreshPending = false;

  public constructor() {
    this.statusService.projectionChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.mergeCurrentMwsdStatus());

    const freshnessTimer = setInterval(() => this.freshnessNow.set(Date.now()), 5_000);

    this.destroyRef.onDestroy(() => this.stop());
    this.destroyRef.onDestroy(() => clearInterval(freshnessTimer));
  }

  public start(): void {
    if (this.loadState().status === 'unsupported') {
      return;
    }

    this.stop();
    this.loadState.set({status: 'loading'});
    this.statusService.resetForStart();

    this.versionSub = this.api.showVersion().subscribe({
      next: (version) => {
        this.version = version;

        this.startPolling();
        this.statusService.start();
      },
      error: (error: unknown) => {
        this.loadState.set({status: 'error', error: this.toRequestError(error)});
      },
    });
  }

  public retry(): void {
    if (this.loadState().status === 'unsupported') {
      return;
    }

    this.start();
  }

  public refreshNow(): void {
    if (!this.pollingStarted) {
      return;
    }

    if (this.pollInFlight) {
      this.refreshPending = true;

      return;
    }

    this.refreshTrigger.next();
  }

  private stop(): void {
    this.pollingStarted = false;
    this.pollInFlight = false;
    this.refreshPending = false;

    this.versionSub?.unsubscribe();
    this.versionSub = null;
    this.pollSub?.unsubscribe();
    this.pollSub = null;
    this.statusService.stop();
    this.refreshTimerSub?.unsubscribe();
    this.refreshTimerSub = null;
  }

  private toRequestError(error: unknown): MwsRequestError {
    return {message: error instanceof Error ? error.message : String(error)};
  }

  private markRequestStarted(): void {
    const state = this.loadState();

    if (state.status === 'success' || state.status === 'refreshing') {
      this.loadState.set({status: 'refreshing', data: state.data});
    } else if (state.status === 'error' && state.data !== undefined) {
      this.loadState.set({status: 'refreshing', data: state.data});
    } else if (state.status !== 'unsupported') {
      this.loadState.set({status: 'loading'});
    }
  }

  private startPolling(): void {
    this.pollingStarted = true;

    const visible$ = fromEvent(document, 'visibilitychange').pipe(filter(() => !document.hidden));

    this.pollSub = merge(timer(0, POLL_INTERVAL_MS), visible$, this.refreshTrigger)
      .pipe(
        filter(() => !document.hidden),
        exhaustMap(() =>
          defer(() => {
            this.markRequestStarted();
            this.pollInFlight = true;

            const obs$ = {
              memberResult: this.api.showMwsMember(),
              hosts: this.api.showDeviceList(),
              bridge: this.api.showBridge0(),
              controllerName: this.api.showControllerDescription(),
              controllerTelemetry: this.api.showControllerTelemetry(),
            };

            return forkJoin(obs$)
              .pipe(
                map(({memberResult, hosts, bridge, controllerName, controllerTelemetry}): PollResult =>
                  memberResult.kind === 'unsupported'
                    ? {kind: 'unsupported', reason: 'MWS is unsupported by this device'}
                    : {kind: 'ok', members: memberResult.members, hosts, bridge, controllerName, controllerTelemetry}
                ),
                catchError((error: unknown) =>
                  of<PollResult>({
                    kind: 'error',
                    error: this.toRequestError(error),
                  })
                ),
                finalize(() => {
                  this.pollInFlight = false;

                  if (this.refreshPending) {
                    this.refreshPending = false;

                    this.refreshTimerSub?.unsubscribe();

                    this.refreshTimerSub = timer(0)
                      .subscribe(() => {
                        this.refreshTimerSub = null;

                        if (this.pollingStarted) {
                          this.refreshTrigger.next();
                        }
                      });
                  }
                }),
              );
          })
        ),
      )
      .subscribe((result) => this.applyPoll(result));
  }

  protected setExtraFeaturesAvailability(next: ExtraFeaturesAvailability): void {
    this.statusService.setExtraFeaturesAvailability(next);
  }

  protected publishSnapshot(
    version: ShowVersionRecord,
    members: MwsMemberRecord[],
    hosts: DeviceHostRecord[],
    bridge: BridgeInterfaceRecord,
  ): void {
    this.version = version;

    this.applyPoll(
      {kind: 'ok', members, hosts, bridge, controllerName: this.deviceInfo.deviceName, controllerTelemetry: null},
      false,
    );
  }

  private applyPoll(result: PollResult, applyMwsdStatus = this.backend !== null): void {
    if (result.kind === 'error') {
      const state = this.loadState();

      this.loadState.set(
        state.status === 'refreshing'
          ? {status: 'error', error: result.error, data: state.data}
          : {status: 'error', error: result.error},
      );

      return;
    }

    if (result.kind === 'unsupported') {
      this.loadState.set({status: 'unsupported', reason: result.reason});
      this.setExtraFeaturesAvailability('unavailable');
      this.stop();

      return;
    }

    const controller: ControllerInfo = {
      mac: result.bridge.mac,
      ip: result.bridge.address,
      name: result.controllerName !== null && result.controllerName.trim() !== ''
        ? result.controllerName
        : this.deviceInfo.deviceName.trim() !== ''
        ? this.deviceInfo.deviceName
        : (this.version?.model ?? result.bridge.mac),
      model: this.version?.model ?? null,
      firmware: this.version?.firmware ?? null,
      interfaceUptime: result.bridge.uptime,
      isOnline: result.bridge.isOnline,
    };
    let roots = buildMap(result.members, result.hosts, controller, result.controllerTelemetry);

    if (applyMwsdStatus && this.backend !== null) {
      this.statusService.retainForNodes(roots);
      roots = this.statusService.mergeInto(roots, Date.now());
    }

    this.loadState.set({status: 'success', data: roots});
    this.snapshotSubject.next(roots);
    this.lastUpdatedAt.set(Date.now());
  }

  private mergeCurrentMwsdStatus(): void {
    if (this.backend === null) {
      return;
    }

    const state = this.loadState();
    const roots = state.status === 'success' || state.status === 'refreshing'
      ? state.data
      : state.status === 'error'
      ? state.data
      : undefined;

    if (roots === undefined) {
      return;
    }

    const merged = this.statusService.mergeInto(roots, Date.now());

    if (state.status === 'success') {
      this.loadState.set({status: 'success', data: merged});
    } else if (state.status === 'refreshing') {
      this.loadState.set({status: 'refreshing', data: merged});
    } else if (state.status === 'error' && state.data !== undefined) {
      this.loadState.set({status: 'error', error: state.error, data: merged});
    } else {
      return;
    }

    this.snapshotSubject.next(merged);
  }
}
