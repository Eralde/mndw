import {TestBed} from '@angular/core/testing';
import type {HostInfo} from '@mndw/sdk';
import {of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MwsApiService, type MwsMemberResult} from '../api/mws-api.service';
import {normalizeBridge, normalizeDeviceHosts, normalizeMembers, normalizeVersion} from '../api/normalize';
import {loadFixture} from '../fixtures/load';
import {HOST_INFO} from '../tokens';
import {MwsDataService, POLL_INTERVAL_MS} from './mws-data.service';

const HOST: HostInfo = {deviceName: 'My Router', vendor: 'Keenetic', firmwareVersion: '5.1.1', theme: 'light'};

interface FakeApi {
  showVersion: ReturnType<typeof vi.fn>;
  showMwsMember: ReturnType<typeof vi.fn>;
  showDeviceList: ReturnType<typeof vi.fn>;
  showBridge0: ReturnType<typeof vi.fn>;
}

function goodApi(): FakeApi {
  return {
    showVersion: vi.fn(() => of(normalizeVersion(loadFixture('show-version.json')))),
    showMwsMember: vi.fn(() =>
      of<MwsMemberResult>({kind: 'ok', members: normalizeMembers(loadFixture('show-mws-member.json'))})
    ),
    showDeviceList: vi.fn(() => of(normalizeDeviceHosts(loadFixture('show-device-list.json')))),
    showBridge0: vi.fn(() => of(normalizeBridge(loadFixture('show-interface-bridge0.json')))),
  };
}

function makeService(api: FakeApi): MwsDataService {
  TestBed.configureTestingModule({
    providers: [
      MwsDataService,
      {provide: MwsApiService, useValue: api as unknown as MwsApiService},
      {provide: HOST_INFO, useValue: HOST},
    ],
  });

  return TestBed.inject(MwsDataService);
}

describe('MwsDataService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaches ready with the built forest after version + first poll succeed', async () => {
    const service = makeService(goodApi());

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('ready');
    expect(service.roots()).toHaveLength(1);
    expect(service.roots()[0].name).toBe('My Router');
    expect(service.pollError()).toBe(false);
  });

  it('stays in error and never polls when show.version fails; retry recovers', async () => {
    const api = goodApi();

    api.showVersion.mockReturnValueOnce(throwError(() => new Error('boom')));

    const service = makeService(api);

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

    const service = makeService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('error');
  });

  it('keeps the last good map and raises pollError on a later failure, then clears it', async () => {
    const api = goodApi();
    const service = makeService(api);

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

    const service = makeService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('empty');
    expect(service.roots()).toHaveLength(1);
  });

  it('maps the unsupported classification to the unsupported phase', async () => {
    const api = goodApi();

    api.showMwsMember.mockReturnValue(of<MwsMemberResult>({kind: 'unsupported'}));

    const service = makeService(api);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.phase()).toBe('unsupported');
  });

  it('skips polls while hidden and refreshes immediately on becoming visible', async () => {
    const api = goodApi();
    const service = makeService(api);

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
    const service = makeService(goodApi());
    const emissions: number[] = [];

    service.snapshots$.subscribe((roots) => emissions.push(roots.length));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(emissions).toEqual([1, 1]);
  });
});
