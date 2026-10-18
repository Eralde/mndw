import {DestroyRef, Injectable, type Signal, type WritableSignal, inject, signal} from '@angular/core';
import {BackendBlocked, type BackendBlocker, type BackendClient, type BackendStatus} from '@mndw/sdk';
import {
  type Observable,
  Subject,
  type Subscription,
  catchError,
  defer,
  exhaustMap,
  filter,
  finalize,
  from,
  map,
  of,
  switchMap,
  timeout,
  timer,
} from 'rxjs';
import {
  type PersistentSessionSnapshot,
  mergePersistentSessions,
  newPersistentSessionSnapshot,
  parsePersistentSessionsResponse,
  retainPersistentSessionsForNodes,
} from '../api/mwsd-status';
import type {MwsNode} from '../domain/mws/mws.types';
import {MWSD_BACKEND} from '../tokens';

export const MWSD_STATUS_POLL_INTERVAL_MS = 3_000;
export const MWSD_STATUS_REQUEST_TIMEOUT_MS = 5_000;
export const EXTRA_FEATURES_STARTING_TIMEOUT_MS = 30_000;

export type ExtraFeaturesAvailability =
  | 'checking'
  | 'active'
  | 'starting'
  | 'unavailable'
  | 'limited'
  | 'blocked'
  | 'incompatible';

export type ExtraFeaturesPresentation = ExtraFeaturesAvailability | 'taking-longer';

export type ExtraFeaturesSetupReason = 'permission' | 'controller-token' | 'extender-session' | 'generic';

type MwsdPollOutcome =
  | {kind: 'snapshot'; snapshot: PersistentSessionSnapshot}
  | {
    kind: 'availability';
    availability: Exclude<ExtraFeaturesAvailability, 'checking' | 'active'>;
    setupReasons?: ExtraFeaturesSetupReason[];
  };

const backendErrorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const candidate = error as {code?: unknown; daemonCode?: unknown};

  if (typeof candidate.daemonCode === 'string') {
    return candidate.daemonCode;
  }

  return typeof candidate.code === 'string' ? candidate.code : null;
};

@Injectable()
export class MwsdStatusService {
  private readonly backend = inject(MWSD_BACKEND);
  private readonly destroyRef = inject(DestroyRef);
  private readonly extraFeaturesAvailabilityWritable: WritableSignal<ExtraFeaturesAvailability> = signal('checking');
  private readonly extraFeaturesPresentationWritable: WritableSignal<ExtraFeaturesPresentation> = signal('checking');
  private readonly extraFeaturesSetupReasonsWritable: WritableSignal<ExtraFeaturesSetupReason[]> = signal([]);
  private readonly projectionChangesSubject = new Subject<void>();

  public readonly extraFeaturesAvailability: Signal<ExtraFeaturesAvailability> = this.extraFeaturesAvailabilityWritable
    .asReadonly();
  public readonly extraFeaturesPresentation: Signal<ExtraFeaturesPresentation> = this.extraFeaturesPresentationWritable
    .asReadonly();
  public readonly extraFeaturesSetupReasons: Signal<ExtraFeaturesSetupReason[]> = this.extraFeaturesSetupReasonsWritable
    .asReadonly();
  public readonly projectionChanges$: Observable<void> = this.projectionChangesSubject.asObservable();

  private statusSub: Subscription | null = null;
  private startingSince: number | null = null;
  private consecutiveLimitedPolls = 0;
  private lastPersistentSessions: PersistentSessionSnapshot = newPersistentSessionSnapshot(false, new Map());

  public constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  public resetForStart(): void {
    this.stop();
    this.extraFeaturesSetupReasonsWritable.set([]);
    this.setExtraFeaturesAvailability(this.backend === null ? 'unavailable' : 'checking');
  }

  public start(): void {
    const backend = this.backend;

    if (backend === null) {
      return;
    }

    this.statusSub?.unsubscribe();
    this.statusSub = timer(0, MWSD_STATUS_POLL_INTERVAL_MS)
      .pipe(
        filter(() => !document.hidden),
        exhaustMap(() => this.fetchMwsdStatus(backend)),
      )
      .subscribe((outcome) => this.applyMwsdOutcome(outcome));
  }

  public stop(): void {
    this.statusSub?.unsubscribe();
    this.statusSub = null;
    this.lastPersistentSessions = newPersistentSessionSnapshot(false, new Map());
    this.startingSince = null;
    this.consecutiveLimitedPolls = 0;
  }

  public setExtraFeaturesAvailability(next: ExtraFeaturesAvailability): void {
    this.extraFeaturesAvailabilityWritable.set(next);

    if (next === 'starting') {
      const now = Date.now();

      this.startingSince ??= now;
      this.consecutiveLimitedPolls = 0;

      this.extraFeaturesPresentationWritable.set(
        now - this.startingSince >= EXTRA_FEATURES_STARTING_TIMEOUT_MS
          ? 'taking-longer'
          : 'starting',
      );

      return;
    }

    this.startingSince = null;

    if (next !== 'limited') {
      this.consecutiveLimitedPolls = 0;
      this.extraFeaturesPresentationWritable.set(next);

      return;
    }

    this.consecutiveLimitedPolls += 1;

    if (this.consecutiveLimitedPolls >= 2) {
      this.extraFeaturesPresentationWritable.set('limited');
    }
  }

  public retainForNodes(roots: MwsNode[]): void {
    this.lastPersistentSessions = retainPersistentSessionsForNodes(roots, this.lastPersistentSessions);
  }

  public mergeInto(roots: MwsNode[], now: number): MwsNode[] {
    return mergePersistentSessions(roots, this.lastPersistentSessions, now);
  }

  private fetchMwsdStatus(backend: BackendClient): Observable<MwsdPollOutcome> {
    const controller = new AbortController();
    const nodesObs$ = from(backend.fetch('nodes', {signal: controller.signal}));

    return defer(() => nodesObs$)
      .pipe(
        timeout({each: MWSD_STATUS_REQUEST_TIMEOUT_MS}),
        switchMap((response) =>
          response.ok
            ? defer(() => from(response.json())).pipe(
              timeout({each: MWSD_STATUS_REQUEST_TIMEOUT_MS}),
              map((value): MwsdPollOutcome => {
                const snapshot = parsePersistentSessionsResponse(value, this.lastPersistentSessions);

                return snapshot === null
                  ? {kind: 'availability', availability: 'limited'}
                  : {kind: 'snapshot', snapshot};
              }),
              switchMap((outcome) =>
                outcome.kind === 'snapshot'
                  ? this.classifyPersistentSnapshot(backend, controller.signal, outcome.snapshot)
                  : of(outcome)
              ),
            )
            : this.queryBackendStatus(backend, controller.signal)
        ),
        catchError((error: unknown) => this.queryBackendStatus(backend, controller.signal, error)),
        finalize(() => controller.abort()),
      );
  }

  private classifyPersistentSnapshot(
    backend: BackendClient,
    abortSignal: AbortSignal,
    snapshot: PersistentSessionSnapshot,
  ): Observable<MwsdPollOutcome> {
    if (
      !snapshot.available
      || !snapshot.countsKnown
      || snapshot.targetCount === 0
      || snapshot.sessionCount > 0
      || typeof backend.status !== 'function'
    ) {
      return of({kind: 'snapshot', snapshot});
    }

    return defer(() => from(backend.status?.({signal: abortSignal})))
      .pipe(
        timeout({each: MWSD_STATUS_REQUEST_TIMEOUT_MS}),
        map((status): MwsdPollOutcome =>
          status.state === 'ready'
            ? {kind: 'availability', availability: 'unavailable',
              setupReasons: ['extender-session'] as ExtraFeaturesSetupReason[]}
            : this.classifyBackendStatus(status)
        ),
        catchError(() => of<MwsdPollOutcome>({kind: 'availability', availability: 'limited'})),
      );
  }

  private queryBackendStatus(
    backend: BackendClient,
    abortSignal: AbortSignal,
    nodesError?: unknown,
  ): Observable<MwsdPollOutcome> {
    if (typeof backend.status !== 'function') {
      return of(
        nodesError === undefined
          ? {kind: 'availability', availability: 'limited'}
          : this.classifyMwsdError(nodesError),
      );
    }

    return defer(() => from(backend.status({signal: abortSignal})))
      .pipe(
        timeout({each: MWSD_STATUS_REQUEST_TIMEOUT_MS}),
        map((status) => this.classifyBackendStatus(status)),
        catchError(() => of<MwsdPollOutcome>({kind: 'availability', availability: 'limited'})),
      );
  }

  private classifyBackendStatus(status: BackendStatus): MwsdPollOutcome {
    if (status.state === 'starting' || status.state === 'maintenance') {
      return {kind: 'availability', availability: 'starting'};
    }

    if (status.state === 'unavailable') {
      return {kind: 'availability', availability: 'unavailable'};
    }

    if (status.state === 'incompatible') {
      return {kind: 'availability', availability: 'incompatible'};
    }

    if (status.state === 'blocked' || status.state === 'disabled' || status.state === 'not-approved') {
      return {
        kind: 'availability',
        availability: 'blocked',
        setupReasons: status.state === 'blocked' ? this.classifySetupReasons(status.blockers) : ['generic'],
      };
    }

    return {kind: 'availability', availability: 'limited'};
  }

  private classifySetupReasons(blockers: BackendBlocker[]): ExtraFeaturesSetupReason[] {
    const reasons = new Set<ExtraFeaturesSetupReason>();

    for (const blocker of blockers) {
      if (blocker.reason === 'not-granted' && blocker.prerequisite === undefined) {
        reasons.add('permission');
      } else if (blocker.reason === 'prerequisite-unavailable' && blocker.prerequisite === 'controller-token') {
        reasons.add('controller-token');
      } else {
        reasons.add('generic');
      }
    }

    return [...reasons];
  }

  private classifyMwsdError(error: unknown): MwsdPollOutcome {
    const code = backendErrorCode(error);

    if (code === 'BACKEND_STARTING' || code === 'BACKEND_MAINTENANCE') {
      return {kind: 'availability', availability: 'starting'};
    }

    if (code === 'BACKEND_UNAVAILABLE') {
      return {kind: 'availability', availability: 'unavailable'};
    }

    if (code === 'BACKEND_BLOCKED') {
      const blockers = error instanceof BackendBlocked ? error.blockers : [];

      return {
        kind: 'availability',
        availability: 'blocked',
        setupReasons: blockers.length > 0 ? this.classifySetupReasons(blockers) : ['generic'],
      };
    }

    if (code === 'DISABLED' || code === 'NOT_APPROVED') {
      return {kind: 'availability', availability: 'blocked', setupReasons: ['generic']};
    }

    if (code === 'BACKEND_INCOMPATIBLE') {
      return {kind: 'availability', availability: 'incompatible'};
    }

    return {kind: 'availability', availability: 'limited'};
  }

  private applyMwsdOutcome(outcome: MwsdPollOutcome): void {
    if (outcome.kind === 'snapshot') {
      this.lastPersistentSessions = outcome.snapshot;

      this.extraFeaturesSetupReasonsWritable.set([]);
      this.setExtraFeaturesAvailability(outcome.snapshot.available ? 'active' : 'unavailable');
    } else {
      this.makePersistentProjectionUnavailable();
      this.extraFeaturesSetupReasonsWritable.set(outcome.setupReasons ?? []);
      this.setExtraFeaturesAvailability(outcome.availability);
    }

    this.projectionChangesSubject.next();
  }

  private makePersistentProjectionUnavailable(): void {
    this.lastPersistentSessions = newPersistentSessionSnapshot(false, this.lastPersistentSessions.sessions);
  }
}
