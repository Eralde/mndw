import {DestroyRef, Injectable, inject, signal} from '@angular/core';
import {
  ReplaySubject,
  type Subscription,
  catchError,
  exhaustMap,
  filter,
  forkJoin,
  fromEvent,
  map,
  merge,
  of,
  timer,
} from 'rxjs';
import {MwsApiService} from '../api/mws-api.service';
import type {BridgeInterfaceRecord, DeviceHostRecord, MwsMemberRecord, ShowVersionRecord} from '../api/rci.types';
import {buildMap} from '../domain/mws/map-builder';
import type {ControllerInfo, MwsNode} from '../domain/mws/mws.types';
import {HOST_INFO} from '../tokens';

export const POLL_INTERVAL_MS = 10_000;

export type MwsViewPhase = 'loading' | 'error' | 'unsupported' | 'empty' | 'ready';

type PollResult =
  | {kind: 'ok'; members: MwsMemberRecord[]; hosts: DeviceHostRecord[]; bridge: BridgeInterfaceRecord}
  | {kind: 'unsupported'}
  | {kind: 'error'};

@Injectable()
export class MwsDataService {
  private readonly api = inject(MwsApiService);
  private readonly hostInfo = inject(HOST_INFO);
  private readonly destroyRef = inject(DestroyRef);

  public readonly phase = signal<MwsViewPhase>('loading');
  public readonly roots = signal<MwsNode[]>([]);
  public readonly pollError = signal<boolean>(false);

  private readonly snapshotSubject = new ReplaySubject<MwsNode[]>(1);
  public readonly snapshots$ = this.snapshotSubject.asObservable();

  private version: ShowVersionRecord | null = null;
  private versionSub: Subscription | null = null;
  private pollSub: Subscription | null = null;
  private hasSnapshot = false;

  public constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  public start(): void {
    this.phase.set('loading');
    this.versionSub = this.api.showVersion().subscribe({
      next: (version) => {
        this.version = version;
        this.startPolling();
      },
      error: () => this.phase.set('error'),
    });
  }

  public retry(): void {
    this.stop();
    this.hasSnapshot = false;
    this.start();
  }

  private stop(): void {
    this.versionSub?.unsubscribe();
    this.versionSub = null;
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  private startPolling(): void {
    const visible$ = fromEvent(document, 'visibilitychange').pipe(filter(() => !document.hidden));

    this.pollSub = merge(timer(0, POLL_INTERVAL_MS), visible$)
      .pipe(
        filter(() => !document.hidden),
        exhaustMap(() =>
          forkJoin({
            memberResult: this.api.showMwsMember(),
            hosts: this.api.showDeviceList(),
            bridge: this.api.showBridge0(),
          }).pipe(
            map(({memberResult, hosts, bridge}): PollResult =>
              memberResult.kind === 'unsupported'
                ? {kind: 'unsupported'}
                : {kind: 'ok', members: memberResult.members, hosts, bridge}
            ),
            catchError(() => of<PollResult>({kind: 'error'})),
          )
        ),
      )
      .subscribe((result) => this.applyPoll(result));
  }

  private applyPoll(result: PollResult): void {
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
      name: this.hostInfo.deviceName.trim() !== ''
        ? this.hostInfo.deviceName
        : (this.version?.model ?? result.bridge.mac),
      model: this.version?.model ?? null,
      firmware: this.version?.firmware ?? null,
      interfaceUptime: result.bridge.uptime,
      isOnline: result.bridge.isOnline,
    };
    const roots = buildMap(result.members, result.hosts, controller);

    this.roots.set(roots);
    this.snapshotSubject.next(roots);
    this.hasSnapshot = true;
    this.pollError.set(false);
    this.phase.set(result.members.length === 0 ? 'empty' : 'ready');
  }
}
