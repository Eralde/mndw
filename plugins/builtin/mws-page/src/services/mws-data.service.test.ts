import {TestBed} from '@angular/core/testing';
import {
  BackendBadGateway,
  BackendDisabled,
  BackendIncompatible,
  BackendMaintenance,
  BackendNotApproved,
  BackendStarting,
  type BackendStatus,
  BackendUnavailable,
} from '@mndw/sdk';
import {Subject, of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MwsMemberResult} from '../api/mws-api.service';
import {findNodeById} from '../domain/mws/map-builder';
import {fakeBackend, goodApi, makeLiveService, makeLiveServiceWithBackend} from '../test-support/mws-data-test-support';
import {MWSD_STATUS_POLL_INTERVAL_MS, MWSD_STATUS_REQUEST_TIMEOUT_MS, POLL_INTERVAL_MS} from './mws-data.service';

const activeResponse = (): Response =>
  new Response(
    JSON.stringify({
      lastRefreshAt: new Date().toISOString(),
      persistentAvailable: true,
      persistentSessions: [{mac: '02:7d:4a:91:c3:21', live: true, telemetry: {sampledAt: new Date().toISOString()}}],
    }),
    {status: 200},
  );

describe('MwsDataService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes map data and mwsd status every three seconds', () => {
    expect(POLL_INTERVAL_MS).toBe(3_000);
    expect(MWSD_STATUS_POLL_INTERVAL_MS).toBe(3_000);
  });

  it('reaches ready with the built forest after version + first poll succeed', async () => {
    const service = makeLiveService(goodApi());

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('ready');
    expect(service.roots()).toHaveLength(1);
    expect(service.roots()[0].name).toBe('My Router');
    expect(service.pollError()).toBe(false);
    expect(service.lastUpdatedAt()).not.toBeNull();
  });

  it('starts in checking and marks absent backend unavailable without affecting topology', async () => {
    const service = makeLiveService(goodApi());

    expect(service.extraFeaturesAvailability()).toBe('checking');
    expect(service.extraFeaturesPresentation()).toBe('checking');

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('ready');
    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesPresentation()).toBe('unavailable');
  });

  it('debounces limited header presentation while invalidating persistent projection immediately', async () => {
    const api = goodApi();
    const fetch = vi.fn()
      .mockResolvedValueOnce(activeResponse())
      .mockRejectedValueOnce(new BackendBadGateway('nodes'))
      .mockRejectedValueOnce(new BackendBadGateway('nodes'));
    const service = makeLiveServiceWithBackend(api, fakeBackend(fetch));

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.extraFeaturesAvailability()).toBe('active');
    expect(service.extraFeaturesPresentation()).toBe('active');

    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);
    expect(service.extraFeaturesAvailability()).toBe('limited');
    expect(service.extraFeaturesPresentation()).toBe('active');
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('unavailable');
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.wifiPower).toBeUndefined();

    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);
    expect(service.extraFeaturesPresentation()).toBe('limited');
  });

  it.each(
    [
      ['starting', new BackendStarting('nodes', null)],
      ['starting', new BackendMaintenance('nodes', 4)],
      ['unavailable', new BackendUnavailable('nodes')],
      ['blocked', new BackendDisabled('nodes')],
      ['blocked', new BackendNotApproved('nodes')],
      ['incompatible', new BackendIncompatible('nodes')],
    ] as const,
  )('maps lifecycle error to immediate %s availability', async (expected, error) => {
    const service = makeLiveServiceWithBackend(
      goodApi(),
      fakeBackend(vi.fn().mockRejectedValueOnce(error)),
    );

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe(expected);
    expect(service.extraFeaturesPresentation()).toBe(expected);
  });

  it.each(
    [
      ['blocked', 'DISABLED'],
      ['blocked', 'NOT_APPROVED'],
      ['starting', 'BACKEND_STARTING'],
      ['unavailable', 'BACKEND_UNAVAILABLE'],
      ['incompatible', 'BACKEND_INCOMPATIBLE'],
      ['limited', 'BAD_GATEWAY'],
    ] as const,
  )('classifies stable backend code %s across SDK bundle boundaries', async (expected, code) => {
    const foreignError = code === 'DISABLED' || code === 'NOT_APPROVED'
      ? Object.assign(new Error(`foreign ${code}`), {code})
      : Object.assign(new Error(`foreign ${code}`), {daemonCode: code});
    const service = makeLiveServiceWithBackend(
      goodApi(),
      fakeBackend(vi.fn().mockRejectedValueOnce(foreignError)),
    );

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe(expected);
    // 'limited' presentation is debounced (>=2 consecutive limited polls); a single poll leaves
    // presentation at its initial 'checking'. See the dedicated debounce test above.
    expect(service.extraFeaturesPresentation()).toBe(expected === 'limited' ? 'checking' : expected);
  });

  it('resets availability and presentation before every reconnect cycle', async () => {
    const fetch = vi.fn(() => Promise.resolve(activeResponse()));
    const service = makeLiveServiceWithBackend(goodApi(), fakeBackend(fetch));

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.extraFeaturesAvailability()).toBe('active');

    service.start();
    expect(service.extraFeaturesAvailability()).toBe('checking');
    expect(service.extraFeaturesPresentation()).toBe('checking');

    await vi.advanceTimersByTimeAsync(0);
    expect(service.extraFeaturesAvailability()).toBe('active');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the refreshed typed controller description as the graph name', async () => {
    const api = goodApi();
    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.roots()[0].name).toBe('My Router');

    api.showControllerDescription.mockReturnValueOnce(of('Renamed Router'));
    service.refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.roots()[0].name).toBe('Renamed Router');
  });

  it('stays in error and never polls when show.version fails; retry recovers', async () => {
    const api = goodApi();

    api.showVersion.mockReturnValueOnce(throwError(() => new Error('boom')));

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(service.phase()).toBe('error');
    expect(api.showMwsMember).not.toHaveBeenCalled();

    service.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.phase()).toBe('ready');
  });

  it('shows a full-page error when the first poll fails', async () => {
    const api = goodApi();

    api.showMwsMember.mockReturnValueOnce(throwError(() => new Error('boom')));

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('error');
  });

  it('keeps the last good map and raises pollError on a later failure, then clears it', async () => {
    const api = goodApi();
    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.phase()).toBe('ready');

    api.showDeviceList.mockReturnValueOnce(throwError(() => new Error('boom')));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(service.phase()).toBe('ready');
    expect(service.pollError()).toBe(true);
    expect(service.roots()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(service.pollError()).toBe(false);
  });

  it('maps an empty member list to ready with a controller-only forest', async () => {
    const api = goodApi();

    api.showMwsMember.mockReturnValue(of<MwsMemberResult>({kind: 'ok', members: []}));

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('ready');
    expect(service.roots()).toHaveLength(1);
    expect(service.lastUpdatedAt()).not.toBeNull();
  });

  it('maps the unsupported classification to the unsupported phase', async () => {
    const api = goodApi();

    api.showMwsMember.mockReturnValue(of<MwsMemberResult>({kind: 'unsupported'}));

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('unsupported');
    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesPresentation()).toBe('unavailable');
  });

  it('treats unsupported as terminal until the service is remounted', async () => {
    const api = goodApi();

    api.showMwsMember.mockReturnValue(of<MwsMemberResult>({kind: 'unsupported'}));

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    const callsAfterUnsupported = api.showMwsMember.mock.calls.length;

    service.retry();
    service.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(service.phase()).toBe('unsupported');
    expect(api.showMwsMember).toHaveBeenCalledTimes(callsAfterUnsupported);
  });

  it('skips polls while hidden and refreshes immediately on becoming visible', async () => {
    const api = goodApi();
    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {configurable: true, value: false});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.showMwsMember).toHaveBeenCalledTimes(2);
  });

  it('emits each good forest on snapshots$', async () => {
    const service = makeLiveService(goodApi());
    const emissions: number[] = [];

    service.snapshots$.subscribe((roots) => emissions.push(roots.length));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(emissions).toEqual([1, 1]);
  });

  it('refreshes immediately when polling is idle', async () => {
    const api = goodApi();
    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    service.refreshNow();

    expect(api.showMwsMember).toHaveBeenCalledTimes(2);
  });

  it('coalesces refresh requests that arrive during an active poll', async () => {
    const api = goodApi();
    const pendingMembers = new Subject<MwsMemberResult>();

    api.showMwsMember.mockReturnValueOnce(pendingMembers);

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    service.refreshNow();
    service.refreshNow();
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    pendingMembers.next({kind: 'ok', members: []});
    pendingMembers.complete();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.showMwsMember).toHaveBeenCalledTimes(2);
  });

  it('does not queue a refresh before polling starts', async () => {
    const api = goodApi();
    const service = makeLiveService(api);

    service.refreshNow();
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.showMwsMember).toHaveBeenCalledTimes(1);
  });

  it('recovers a hidden refresh on the next visibility event', async () => {
    const api = goodApi();
    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    service.refreshNow();
    expect(api.showMwsMember).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {configurable: true, value: false});
    document.dispatchEvent(new Event('visibilitychange'));

    expect(api.showMwsMember).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending follow-up when the service is destroyed', async () => {
    const api = goodApi();
    const pendingMembers = new Subject<MwsMemberResult>();

    api.showMwsMember.mockReturnValueOnce(pendingMembers);

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.refreshNow();

    TestBed.resetTestingModule();
    pendingMembers.next({kind: 'ok', members: []});
    pendingMembers.complete();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.showMwsMember).toHaveBeenCalledTimes(1);
  });

  it('polls mwsd independently and annotates a ready RCI map', async () => {
    const api = goodApi();
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRefreshAt: new Date().toISOString(),
            persistentAvailable: true,
            persistentSessions: [{mac: '02:7d:4a:91:c3:21', live: true,
              telemetry: {sampledAt: new Date().toISOString()}}],
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
      )
    );
    const status = vi.fn();
    const backend = fakeBackend(fetch, status);
    const service = makeLiveServiceWithBackend(api, backend);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('ready');
    expect(fetch).toHaveBeenCalledWith('nodes', expect.objectContaining({signal: expect.any(AbortSignal)}));
    expect(status).not.toHaveBeenCalled();
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('live');
  });

  it('asks status before showing extender-session setup when targets have no sessions', async () => {
    const fetch = vi.fn().mockResolvedValue(
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
    );
    const status = vi.fn().mockResolvedValue({
      kind: 'service',
      state: 'ready',
      retryAfterSeconds: null,
    } as BackendStatus);
    const service = makeLiveServiceWithBackend(goodApi(), fakeBackend(fetch, status));

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(status).toHaveBeenCalledTimes(1);
    expect(service.extraFeaturesAvailability()).toBe('unavailable');
    expect(service.extraFeaturesSetupReasons()).toEqual(['extender-session']);
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
  )('maps live backend status %o to %s', async (backendStatus, expected, reasons) => {
    const fetch = vi.fn().mockRejectedValue(new Error('nodes unavailable'));
    const status = vi.fn().mockResolvedValue(
      {kind: 'service', retryAfterSeconds: null, ...backendStatus} as BackendStatus,
    );
    const service = makeLiveServiceWithBackend(goodApi(), fakeBackend(fetch, status));

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe(expected);
    expect(service.extraFeaturesSetupReasons()).toEqual(reasons);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('preserves both blocker setup reasons and maps unknown codes to generic', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('nodes unavailable'));
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
    const service = makeLiveServiceWithBackend(goodApi(), fakeBackend(fetch, status));

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesSetupReasons()).toEqual(['permission', 'controller-token', 'generic']);
  });

  it('maps a failed nodes request with ready status to limited', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('nodes unavailable'));
    const status = vi.fn().mockResolvedValue(
      {kind: 'service', state: 'ready', retryAfterSeconds: null} as BackendStatus,
    );
    const service = makeLiveServiceWithBackend(goodApi(), fakeBackend(fetch, status));

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.extraFeaturesAvailability()).toBe('limited');
    expect(service.extraFeaturesSetupReasons()).toEqual([]);
  });

  it('keeps RCI ready when mwsd rejects and recovers on a later status tick', async () => {
    const api = goodApi();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            lastRefreshAt: new Date().toISOString(),
            persistentAvailable: true,
            persistentSessions: [{mac: '02:7d:4a:91:c3:21', live: true,
              telemetry: {sampledAt: new Date().toISOString()}}],
          }),
          {status: 200},
        ),
      );
    const service = makeLiveServiceWithBackend(api, fakeBackend(fetch));

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.phase()).toBe('ready');
    expect(service.pollError()).toBe(false);

    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.phase()).toBe('ready');
    expect(service.pollError()).toBe(false);
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('live');
  });

  it('times out an ignored-abort request without blocking later status polls', async () => {
    const api = goodApi();
    const pending = new Promise<Response>(() => undefined);
    const fetch = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({lastRefreshAt: new Date().toISOString(), persistentAvailable: true, persistentSessions: []}),
          {status: 200},
        ),
      );
    const service = makeLiveServiceWithBackend(api, fakeBackend(fetch));

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MWSD_STATUS_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(MWSD_STATUS_POLL_INTERVAL_MS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.phase()).toBe('ready');
  });

  it('reapplies the last good mwsd status after an RCI refresh rebuilds the map', async () => {
    const api = goodApi();
    const backend = fakeBackend(vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRefreshAt: new Date().toISOString(),
            persistentAvailable: true,
            persistentSessions: [{mac: '02:7d:4a:91:c3:21', live: true,
              telemetry: {sampledAt: new Date().toISOString()}}],
          }),
          {status: 200},
        ),
      )
    ));
    const service = makeLiveServiceWithBackend(api, backend);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('live');

    service.refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('live');
  });

  it('merges credential-independent persistent session state and reapplies it after topology rebuild', async () => {
    const api = goodApi();
    const backend = fakeBackend(vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRefreshAt: new Date().toISOString(),
            persistentAvailable: true,
            persistentSessions: [{mac: '02:7d:4a:91:c3:21', live: true}],
          }),
          {status: 200},
        ),
      )
    ));
    const service = makeLiveServiceWithBackend(api, backend);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.persistentSession).toBe(true);
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('starting');

    service.refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.persistentSession).toBe(true);
  });
});
