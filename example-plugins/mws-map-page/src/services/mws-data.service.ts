import {DestroyRef, Injectable, inject, signal} from '@angular/core';
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
import type {BackendClient} from '@mndw/sdk';
import {MwsApiService} from '../api/mws-api.service';
import {
  type MwsdStatusSnapshot,
  type PersistentSessionSnapshot,
  mergeMwsdStatuses,
  mergePersistentSessions,
  parseMwsdNodesResponse,
  parsePersistentSessionsResponse,
} from '../api/mwsd-status';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from '../api/rci.types';
import {buildMap} from '../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../domain/mws/mws.types';
import {HOST_INFO, MWSD_BACKEND} from '../tokens';

export const POLL_INTERVAL_MS = 3_000;
export const MWSD_STATUS_POLL_INTERVAL_MS = 3_000;
export const MWSD_STATUS_REQUEST_TIMEOUT_MS = 5_000;

export type MwsViewPhase = 'loading' | 'error' | 'unsupported' | 'empty' | 'ready';

interface MwsdPollSnapshot {
  readonly status: MwsdStatusSnapshot;
  readonly persistentSessions: PersistentSessionSnapshot;
}

type PollResult =
  | {
    kind: 'ok';
    members: MwsMemberRecord[];
    hosts: DeviceHostRecord[];
    bridge: BridgeInterfaceRecord;
    controllerName: string | null;
  }
  | {kind: 'unsupported'}
  | {kind: 'error'};

@Injectable()
export class MwsDataService {
  private readonly api = inject(MwsApiService);
  private readonly hostInfo = inject(HOST_INFO);
  private readonly backend = inject(MWSD_BACKEND);
  private readonly destroyRef = inject(DestroyRef);

  public readonly phase = signal<MwsViewPhase>('loading');
  public readonly roots = signal<MwsNode[]>([]);
  public readonly pollError = signal<boolean>(false);
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
  private hasSnapshot = false;
  private lastMwsdSnapshot: MwsdStatusSnapshot = emptyMwsdSnapshot();
  private lastPersistentSessions: PersistentSessionSnapshot = new Map();

  public constructor() {
    const freshnessTimer = setInterval(() => this.freshnessNow.set(Date.now()), 5_000);

    this.destroyRef.onDestroy(() => this.stop());
    this.destroyRef.onDestroy(() => clearInterval(freshnessTimer));
  }

  public start(): void {
    this.phase.set('loading');

    this.versionSub = this.api.showVersion().subscribe({
      next: (version) => {
        this.version = version;
        this.startPolling();
        this.startMwsdPolling();
      },
      error: () => this.phase.set('error'),
    });
  }

  public retry(): void {
    this.stop();
    this.hasSnapshot = false;
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
    this.lastMwsdSnapshot = emptyMwsdSnapshot();
    this.lastPersistentSessions = new Map();
  }

  private startPolling(): void {
    this.pollingStarted = true;

    const visible$ = fromEvent(document, 'visibilitychange').pipe(filter(() => !document.hidden));

    this.pollSub = merge(timer(0, POLL_INTERVAL_MS), visible$, this.refreshTrigger)
      .pipe(
        filter(() => !document.hidden),
        exhaustMap(() =>
          defer(() => {
            this.pollInFlight = true;

            return forkJoin({
              memberResult: this.api.showMwsMember(),
              hosts: this.api.showDeviceList(),
              bridge: this.api.showBridge0(),
              controllerName: this.api.showControllerDescription(),
            }).pipe(
              map(({memberResult, hosts, bridge, controllerName}): PollResult =>
                memberResult.kind === 'unsupported'
                  ? {kind: 'unsupported'}
                  : {kind: 'ok', members: memberResult.members, hosts, bridge, controllerName}
              ),
              catchError(() => of<PollResult>({kind: 'error'})),
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
          this.lastMwsdSnapshot = snapshot.status;
          this.lastPersistentSessions = snapshot.persistentSessions;
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
          ? defer(() => from(response.json())).pipe(map((value): MwsdPollSnapshot => ({
            status: parseMwsdNodesResponse(value, Date.now()),
            persistentSessions: parsePersistentSessionsResponse(value),
          })))
          : of<MwsdPollSnapshot | null>(null)
      ),
      catchError(() => of<MwsdStatusSnapshot | null>(null)),
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
      if (this.hasSnapshot) {
        this.pollError.set(true);
      } else {
        this.phase.set('error');
      }

      return;
    }

    if (result.kind === 'unsupported') {
      this.phase.set('unsupported');

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
      roots = mergeMwsdStatuses(roots, this.lastMwsdSnapshot, Date.now());
      roots = mergePersistentSessions(roots, this.lastPersistentSessions);
    }

    this.roots.set(roots);
    this.snapshotSubject.next(roots);
    this.lastUpdatedAt.set(Date.now());
    this.hasSnapshot = true;
    this.pollError.set(false);
    this.phase.set(result.members.length === 0 ? 'empty' : 'ready');
  }

  private mergeCurrentMwsdStatus(): void {
    if (this.backend === null || !this.hasSnapshot) {
      return;
    }

    const roots = mergeMwsdStatuses(this.roots(), this.lastMwsdSnapshot, Date.now());
    const merged = mergePersistentSessions(roots, this.lastPersistentSessions);

    this.roots.set(merged);
    this.snapshotSubject.next(merged);
  }
}

function emptyMwsdSnapshot(): MwsdStatusSnapshot {
  return {credState: 'absent', lastRefreshAt: null, nodes: new Map()};
}
