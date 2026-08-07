import {TestBed} from '@angular/core/testing';
import {Subject, of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MwsMemberResult} from '../api/mws-api.service';
import {findNodeById} from '../domain/mws/map-builder';
import {fakeBackend, goodApi, makeLiveService, makeLiveServiceWithBackend} from '../test-support/mws-data-test-support';
import {MWSD_STATUS_POLL_INTERVAL_MS, MWSD_STATUS_REQUEST_TIMEOUT_MS, POLL_INTERVAL_MS} from './mws-data.service';

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

  it('maps an empty member list to the empty phase (controller-only forest still built)', async () => {
    const api = goodApi();

    api.showMwsMember.mockReturnValue(of<MwsMemberResult>({kind: 'ok', members: []}));

    const service = makeLiveService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('empty');
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
            credState: 'present',
            lastRefreshAt: new Date().toISOString(),
            nodes: [{mac: '02:7d:4a:91:c3:21', state: 'live', lastSuccessAt: new Date().toISOString()}],
          }),
          {status: 200, headers: {'content-type': 'application/json'}},
        ),
      )
    );
    const backend = fakeBackend(fetch);
    const service = makeLiveServiceWithBackend(api, backend);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('ready');
    expect(fetch).toHaveBeenCalledWith('nodes', expect.objectContaining({signal: expect.any(AbortSignal)}));
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('live');
  });

  it('keeps RCI ready when mwsd rejects and recovers on a later status tick', async () => {
    const api = goodApi();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            credState: 'present',
            nodes: [{mac: '02:7d:4a:91:c3:21', state: 'live', lastSuccessAt: new Date().toISOString()}],
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
      .mockResolvedValueOnce(new Response(JSON.stringify({credState: 'present', nodes: []}), {status: 200}));
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
            credState: 'present',
            nodes: [{mac: '02:7d:4a:91:c3:21', state: 'live', lastSuccessAt: new Date().toISOString()}],
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
            credState: 'absent',
            nodes: [],
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
    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.mwsdStatus?.state).toBe('offline');

    service.refreshNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(findNodeById(service.roots(), '02:7d:4a:91:c3:21')?.persistentSession).toBe(true);
  });
});
