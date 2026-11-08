import {TestBed} from '@angular/core/testing';
import {
  BackendBadGateway,
  BackendBlocked,
  type BackendClient,
  BackendDisabled,
  BackendIncompatible,
  BackendMaintenance,
  BackendNotApproved,
  BackendStarting,
  type BackendStatus,
  BackendUnavailable,
} from '@mndw/sdk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MWSD_BACKEND} from '../tokens';
import type {MwsNode} from '../domain/mws/mws.types';
import {
  EXTRA_FEATURES_STARTING_TIMEOUT_MS,
  MWSD_STATUS_POLL_INTERVAL_MS,
  MWSD_STATUS_REQUEST_TIMEOUT_MS,
  MwsdStatusService,
} from './mwsd-status.service';

const activeResponse = (): Response =>
  new Response(
    JSON.stringify({
      lastRefreshAt: new Date().toISOString(),
      persistentAvailable: true,
      persistentSessions: [{mac: '02:7d:4a:91:c3:21', live: true}],
    }),
    {status: 200},
  );

function fakeBackend(fetch: BackendClient['fetch'], status?: BackendClient['status']): BackendClient {
  const backend = {fetch, socket: vi.fn()} as unknown as BackendClient;

  if (status !== undefined) {
    backend.status = status;
  }

  return backend;
}

function makeStatusService(backend: BackendClient | null): MwsdStatusService {
  TestBed.configureTestingModule({
    providers: [MwsdStatusService, {provide: MWSD_BACKEND, useValue: backend}],
  });

  return TestBed.inject(MwsdStatusService);
}

describe('MwsdStatusService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('marks a missing backend unavailable without emitting poll outcomes', async () => {
    const service = makeStatusService(null);
    const outcome = vi.fn();

    service.resetForStart();
    service.projectionChanges$.subscribe(outcome);
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesPresentation()).toBe('unavailable');
    expect(service.extraFeaturesSetupReasons()).toEqual([]);
    expect(outcome).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['starting', new BackendStarting('nodes', null)],
      ['starting', new BackendMaintenance('nodes', 4)],
      ['unavailable', new BackendUnavailable('nodes')],
      ['blocked', new BackendDisabled('nodes')],
      ['blocked', new BackendNotApproved('nodes')],
      [
        'blocked',
        new BackendBlocked('nodes', [{permission: 'persistent-rci-session:write', reason: 'not-granted'}], 2),
      ],
      ['incompatible', new BackendIncompatible('nodes')],
    ] as const,
  )('maps lifecycle error to %s availability', async (expected, error) => {
    const service = makeStatusService(fakeBackend(vi.fn().mockRejectedValue(error)));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe(expected);
    expect(service.extraFeaturesPresentation()).toBe(expected);
  });

  it('maps backend status and blocker reasons', async () => {
    const fetch = vi.fn().mockRejectedValue(new BackendBadGateway('nodes'));
    const status = vi.fn().mockResolvedValue({
      kind: 'service',
      state: 'blocked',
      retryAfterSeconds: null,
      blockers: [
        {permission: 'persistent-rci-session:write', reason: 'not-granted'},
        {permission: 'persistent-rci-session:write', reason: 'prerequisite-unavailable',
          prerequisite: 'controller-token'},
        {permission: 'persistent-rci-session:write', reason: 'future-reason', prerequisite: 'future-code'},
      ],
    } as BackendStatus);
    const service = makeStatusService(fakeBackend(fetch, status));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('blocked');
    expect(service.extraFeaturesPresentation()).toBe('blocked');
    expect(service.extraFeaturesSetupReasons()).toEqual(['permission', 'controller-token', 'generic']);
  });

  it('maps a valid unavailable persistent snapshot to unavailable presentation', async () => {
    const response = new Response(
      JSON.stringify({lastRefreshAt: null, persistentAvailable: false, persistentSessions: []}),
      {status: 200},
    );
    const service = makeStatusService(fakeBackend(vi.fn().mockResolvedValue(response)));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesPresentation()).toBe('unavailable');
  });

  it.each(
    [
      [{state: 'disabled'}, 'blocked', ['generic']],
      [{state: 'not-approved'}, 'blocked', ['generic']],
      [{state: 'maintenance', retryAfterSeconds: 2}, 'starting', []],
      [{state: 'starting', retryAfterSeconds: 3}, 'starting', []],
      [{state: 'incompatible', requiredProtocol: 2, supportedProtocols: [1]}, 'incompatible', []],
      [{state: 'unavailable'}, 'unavailable', []],
      [{state: 'blocked', blockers: [{permission: 'persistent-rci-session:write', reason: 'not-granted'}]}, 'blocked', [
        'permission',
      ]],
      [
        {state: 'blocked',
          blockers: [{permission: 'persistent-rci-session:write', reason: 'prerequisite-unavailable',
            prerequisite: 'controller-token'}]},
        'blocked',
        ['controller-token'],
      ],
    ] as const,
  )('maps backend status %o to %s', async (backendStatus, expected, reasons) => {
    const status = vi.fn().mockResolvedValue(
      {kind: 'service', retryAfterSeconds: null, ...backendStatus} as BackendStatus,
    );
    const service = makeStatusService(fakeBackend(vi.fn().mockRejectedValue(new Error('nodes unavailable')), status));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe(expected);
    expect(service.extraFeaturesSetupReasons()).toEqual(reasons);
  });

  it('reports extender-session setup when backend is ready but has no sessions', async () => {
    const response = new Response(
      JSON.stringify({
        lastRefreshAt: new Date().toISOString(),
        persistentAvailable: true,
        persistentTargetCount: 2,
        persistentSessionCount: 0,
        persistentSessions: [],
      }),
      {status: 200},
    );
    const status = vi.fn().mockResolvedValue(
      {kind: 'service', state: 'ready', retryAfterSeconds: null} as BackendStatus,
    );
    const service = makeStatusService(fakeBackend(vi.fn().mockResolvedValue(response), status));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesSetupReasons()).toEqual(['extender-session']);
  });

  it('preserves setup reasons from a BACKEND_BLOCKED nodes error', async () => {
    const error = new BackendBlocked(
      'nodes',
      [
        {permission: 'persistent-rci-session:write', reason: 'not-granted'},
        {permission: 'persistent-rci-session:write', reason: 'prerequisite-unavailable',
          prerequisite: 'controller-token'},
      ],
      2,
    );
    const service = makeStatusService(fakeBackend(vi.fn().mockRejectedValue(error)));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('blocked');
    expect(service.extraFeaturesSetupReasons()).toEqual(['permission', 'controller-token']);
  });

  it.each(
    [
      ['blocked', 'DISABLED'],
      ['blocked', 'NOT_APPROVED'],
      ['starting', 'BACKEND_STARTING'],
      ['starting', 'BACKEND_MAINTENANCE'],
      ['unavailable', 'BACKEND_UNAVAILABLE'],
      ['incompatible', 'BACKEND_INCOMPATIBLE'],
      ['limited', 'BAD_GATEWAY'],
    ] as const,
  )('classifies backend error code %s without relying on SDK error identity', async (expected, code) => {
    const error = code === 'DISABLED' || code === 'NOT_APPROVED'
      ? Object.assign(new Error(code), {code})
      : Object.assign(new Error(code), {code});
    const service = makeStatusService(fakeBackend(vi.fn().mockRejectedValue(error)));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe(expected);
  });

  it('keeps a ready backend with failed nodes access in limited state', async () => {
    const status = vi.fn().mockResolvedValue(
      {kind: 'service', state: 'ready', retryAfterSeconds: null} as BackendStatus,
    );
    const service = makeStatusService(fakeBackend(vi.fn().mockRejectedValue(new Error('nodes unavailable')), status));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('limited');
    expect(service.extraFeaturesSetupReasons()).toEqual([]);
  });

  it('debounces limited presentation until the second consecutive poll', async () => {
    const fetch = vi.fn().mockRejectedValue(new BackendBadGateway('nodes'));
    const service = makeStatusService(fakeBackend(fetch));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('limited');
    expect(service.extraFeaturesPresentation()).toBe('checking');

    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);

    expect(service.extraFeaturesAvailability()).toBe('limited');
    expect(service.extraFeaturesPresentation()).toBe('limited');
  });

  it('shows taking-longer after continuous starting and resets on a new start', async () => {
    const fetch = vi.fn().mockRejectedValue(new BackendStarting('nodes', null));
    const service = makeStatusService(fakeBackend(fetch));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(EXTRA_FEATURES_STARTING_TIMEOUT_MS);

    expect(service.extraFeaturesPresentation()).toBe('taking-longer');

    service.stop();
    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('starting');
    expect(service.extraFeaturesPresentation()).toBe('starting');
  });

  it('resets both debounce counters on stop without changing visible state', () => {
    const service = makeStatusService(fakeBackend(vi.fn()));

    service.setExtraFeaturesAvailability('active');
    service.setExtraFeaturesAvailability('limited');
    service.stop();

    expect(service.extraFeaturesAvailability()).toBe('limited');
    expect(service.extraFeaturesPresentation()).toBe('active');

    service.setExtraFeaturesAvailability('limited');

    expect(service.extraFeaturesPresentation()).toBe('active');
  });

  it('clears the continuous-starting clock on stop without changing presentation', async () => {
    const service = makeStatusService(fakeBackend(vi.fn()));

    service.setExtraFeaturesAvailability('starting');
    await vi.advanceTimersByTimeAsync(EXTRA_FEATURES_STARTING_TIMEOUT_MS - 1_000);
    service.stop();
    expect(service.extraFeaturesAvailability()).toBe('starting');
    expect(service.extraFeaturesPresentation()).toBe('starting');

    await vi.advanceTimersByTimeAsync(1_000);
    service.setExtraFeaturesAvailability('starting');

    expect(service.extraFeaturesPresentation()).toBe('starting');
  });

  it('emits synchronously after every applied outcome, including repeated unchanged limited outcomes', async () => {
    const service = makeStatusService(fakeBackend(vi.fn().mockRejectedValue(new BackendBadGateway('nodes'))));
    const seen: Array<[string, string]> = [];

    service.resetForStart();
    service.projectionChanges$.subscribe(() => {
      seen.push([service.extraFeaturesAvailability(), service.extraFeaturesPresentation()]);
    });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);

    expect(seen).toEqual([
      ['limited', 'checking'],
      ['limited', 'limited'],
      ['limited', 'limited'],
    ]);
  });

  it('continues polling after an ignored-abort request times out', async () => {
    const pending = new Promise<Response>(() => undefined);
    const fetch = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(activeResponse());
    const service = makeStatusService(fakeBackend(fetch));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(MWSD_STATUS_REQUEST_TIMEOUT_MS + MWSD_STATUS_POLL_INTERVAL_MS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.extraFeaturesAvailability()).toBe('active');
  });

  it('continues polling after a backend status request ignores abort', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRefreshAt: new Date().toISOString(),
            persistentAvailable: true,
            persistentTargetCount: 2,
            persistentSessionCount: 0,
            persistentSessions: [],
          }),
          {status: 200},
        ),
      )
    );
    const pending = new Promise<BackendStatus>(() => undefined);
    const status = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({kind: 'service', state: 'ready', retryAfterSeconds: null} as BackendStatus);
    const service = makeStatusService(fakeBackend(fetch, status));

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(MWSD_STATUS_REQUEST_TIMEOUT_MS + 1_000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(2);
    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesSetupReasons()).toEqual(['extender-session']);
  });

  it('retains current nodes and derives merged status using the supplied timestamp', async () => {
    const response = new Response(
      JSON.stringify({
        lastRefreshAt: '1970-01-01T00:00:00.000Z',
        persistentAvailable: true,
        persistentSessions: [{
          mac: '02:7d:4a:91:c3:21',
          live: true,
          telemetry: {sampledAt: '1970-01-01T00:00:00.000Z'},
        }],
      }),
      {status: 200},
    );
    const service = makeStatusService(fakeBackend(vi.fn().mockResolvedValue(response)));
    const node: MwsNode = {
      id: '02:7d:4a:91:c3:21',
      cid: null,
      name: 'Extender',
      model: null,
      ip: null,
      mac: '02:7d:4a:91:c3:21',
      isController: false,
      isOnline: true,
      fw: null,
      fwAvailable: null,
      system: null,
      backhaul: null,
      parent: null,
      children: [],
      clients: [],
      dualBand: false,
      hwId: null,
      ports: [],
      fwUpdateAvailable: false,
      fwUpdateSandboxes: [],
      wirelessBands: [],
    };

    service.resetForStart();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.retainForNodes([node]);

    expect(service.mergeInto([node], 90_000)[0]?.mwsdStatus?.state).toBe('stale');
  });
});
