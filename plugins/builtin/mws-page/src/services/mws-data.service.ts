import {DestroyRef, Injectable, computed, inject, signal} from '@angular/core';
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
  from,
  fromEvent,
  map,
  merge,
  of,
  switchMap,
  timeout,
  timer,
} from 'rxjs';
import type {BackendClient, LoadState} from '@mndw/sdk';
import {MwsApiService} from '../api/mws-api.service';
import {
  type PersistentSessionSnapshot,
  mergePersistentSessions,
  newPersistentSessionSnapshot,
  parsePersistentSessionsResponse,
  retainPersistentSessionsForNodes,
} from '../api/mwsd-status';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from '../api/rci.types';
import {buildMap} from '../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../domain/mws/mws.types';
import {HOST_INFO, MWSD_BACKEND} from '../tokens';

export const POLL_INTERVAL_MS = 3_000;
export const MWSD_STATUS_POLL_INTERVAL_MS = 3_000;
export const MWSD_STATUS_REQUEST_TIMEOUT_MS = 5_000;

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
  }
  | {kind: 'unsupported'; reason: string}
  | {kind: 'error'; error: MwsRequestError};

@Injectable()
export class MwsDataService {
  private readonly api = inject(MwsApiService);
  private readonly hostInfo = inject(HOST_INFO);
  private readonly backend = inject(MWSD_BACKEND);
  private readonly destroyRef = inject(DestroyRef);

  private readonly loadState = signal<LoadState<MwsNode[], MwsRequestError>>({status: 'loading'});
  public readonly phase = computed<MwsViewPhase>(() => {
    const state = this.loadState();

    if (state.status === 'unsupported') {
      return 'unsupported';
    }

    if (state.status === 'error' && state.data === undefined) {
      return 'error';
    }

    if (
      state.status === 'success' || state.status === 'refreshing'
      || (state.status === 'error' && state.data !== undefined)
    ) {
      return 'ready';
    }

    return 'loading';
  });
  public readonly roots = computed<MwsNode[]>(() => {
    const state = this.loadState();

    return state.status === 'success' || state.status === 'refreshing'
      ? state.data
      : state.status === 'error'
      ? state.data ?? []
      : [];
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
  private mwsdStatusSub: Subscription | null = null;
  private readonly refreshTrigger = new Subject<void>();
  private refreshTimerSub: Subscription | null = null;
  private pollingStarted = false;
  private pollInFlight = false;
  private refreshPending = false;
  private lastPersistentSessions: PersistentSessionSnapshot = newPersistentSessionSnapshot(false, new Map());

  public constructor() {
    const freshnessTimer = setInterval(() => this.freshnessNow.set(Date.now()), 5_000);

    this.destroyRef.onDestroy(() => this.stop());
    this.destroyRef.onDestroy(() => clearInterval(freshnessTimer));
  }

  public start(): void {
    if (this.loadState().status === 'unsupported') {
      return;
    }

    this.loadState.set({status: 'loading'});

    this.versionSub = this.api.showVersion().subscribe({
      next: (version) => {
        this.version = version;
        this.startPolling();
        this.startMwsdPolling();
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

    this.stop();
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
    this.mwsdStatusSub?.unsubscribe();
    this.mwsdStatusSub = null;
    this.refreshTimerSub?.unsubscribe();
    this.refreshTimerSub = null;
    this.lastPersistentSessions = newPersistentSessionSnapshot(false, new Map());
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

            return forkJoin({
              memberResult: this.api.showMwsMember(),
              hosts: this.api.showDeviceList(),
              bridge: this.api.showBridge0(),
              controllerName: this.api.showControllerDescription(),
            }).pipe(
              map(({memberResult, hosts, bridge, controllerName}): PollResult =>
                memberResult.kind === 'unsupported'
                  ? {kind: 'unsupported', reason: 'MWS is unsupported by this device'}
                  : {kind: 'ok', members: memberResult.members, hosts, bridge, controllerName}
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
                  this.refreshTimerSub = timer(0).subscribe(() => {
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

  private startMwsdPolling(): void {
    const backend = this.backend;

    if (backend === null) {
      return;
    }

    this.mwsdStatusSub = timer(0, MWSD_STATUS_POLL_INTERVAL_MS)
      .pipe(
        filter(() => !document.hidden),
        exhaustMap(() => this.fetchMwsdStatus(backend)),
      )
      .subscribe((snapshot) => {
        if (snapshot !== null) {
          this.lastPersistentSessions = snapshot;
        }

        this.mergeCurrentMwsdStatus();
      });
  }

  private fetchMwsdStatus(backend: BackendClient): ReturnType<typeof defer> {
    const controller = new AbortController();

    return defer(() => from(backend.fetch('nodes', {signal: controller.signal}))).pipe(
      timeout({each: MWSD_STATUS_REQUEST_TIMEOUT_MS}),
      switchMap((response) =>
        response.ok
          ? defer(() => from(response.json())).pipe(
            map((value): PersistentSessionSnapshot =>
              parsePersistentSessionsResponse(value, this.lastPersistentSessions)
            ),
          )
          : of<PersistentSessionSnapshot | null>(null)
      ),
      catchError(() => of<PersistentSessionSnapshot | null>(null)),
      finalize(() => controller.abort()),
    );
  }

  protected publishSnapshot(
    version: ShowVersionRecord,
    members: MwsMemberRecord[],
    hosts: DeviceHostRecord[],
    bridge: BridgeInterfaceRecord,
  ): void {
    this.version = version;
    this.applyPoll({kind: 'ok', members, hosts, bridge, controllerName: this.hostInfo.deviceName}, false);
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
      this.stop();

      return;
    }

    const controller: ControllerInfo = {
      mac: result.bridge.mac,
      ip: result.bridge.address,
      name: result.controllerName !== null && result.controllerName.trim() !== ''
        ? result.controllerName
        : this.hostInfo.deviceName.trim() !== ''
        ? this.hostInfo.deviceName
        : (this.version?.model ?? result.bridge.mac),
      model: this.version?.model ?? null,
      firmware: this.version?.firmware ?? null,
      interfaceUptime: result.bridge.uptime,
      isOnline: result.bridge.isOnline,
    };
    let roots = buildMap(result.members, result.hosts, controller);

    if (applyMwsdStatus && this.backend !== null) {
      this.lastPersistentSessions = retainPersistentSessionsForNodes(roots, this.lastPersistentSessions);
      roots = mergePersistentSessions(roots, this.lastPersistentSessions, Date.now());
    }

    this.loadState.set({status: 'success', data: roots});
    this.snapshotSubject.next(roots);
    this.lastUpdatedAt.set(Date.now());
  }

  private mergeCurrentMwsdStatus(): void {
    if (this.backend === null) {
      return;
    }

    const merged = mergePersistentSessions(this.roots(), this.lastPersistentSessions, Date.now());

    const state = this.loadState();

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
