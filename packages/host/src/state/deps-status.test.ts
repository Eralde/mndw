import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  POLL_INTERVAL_MS,
  anyInstalling,
  depsStatusMap,
  getDepsStatus,
  replaceDepsStatuses,
  startDepsPolling,
  stopDepsPolling,
} from './deps-status.svelte.js';

describe('deps-status store', () => {
  it('reports ready for unknown plugins', () => {
    replaceDepsStatuses([]);
    expect(getDepsStatus('unknown')).toBe('ready');
  });

  it('replaces contents wholesale, dropping absent plugins', () => {
    replaceDepsStatuses([
      {name: 'a', depsStatus: 'installing'},
      {name: 'b', depsStatus: 'ready'},
    ]);
    expect(getDepsStatus('a')).toBe('installing');

    replaceDepsStatuses([{name: 'b', depsStatus: 'failed'}]);
    expect(getDepsStatus('a')).toBe('ready');
    expect(getDepsStatus('b')).toBe('failed');
    expect(depsStatusMap.size).toBe(1);
  });

  it('anyInstalling reflects the map', () => {
    replaceDepsStatuses([{name: 'a', depsStatus: 'failed'}]);
    expect(anyInstalling()).toBe(false);

    replaceDepsStatuses([{name: 'a', depsStatus: 'installing'}]);
    expect(anyInstalling()).toBe(true);
  });
});

describe('deps polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopDepsPolling();
    vi.useRealTimers();
  });

  it('is single-flight: next poll waits for prior response', async () => {
    let resolveFirst: (v: Array<{name: string; depsStatus: 'installing'}>) => void = () => {};
    const fetchList = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<Array<{name: string; depsStatus: 'installing'}>>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    replaceDepsStatuses([{name: 'a', depsStatus: 'installing'}]);
    startDepsPolling({fetchList});

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchList).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(fetchList).toHaveBeenCalledTimes(1);

    resolveFirst([{name: 'a', depsStatus: 'installing'}]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it('applies responses wholesale and stops when nothing is installing', async () => {
    const fetchList = vi.fn().mockResolvedValueOnce([{name: 'a', depsStatus: 'ready'}]);

    replaceDepsStatuses([{name: 'a', depsStatus: 'installing'}]);
    startDepsPolling({fetchList});

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getDepsStatus('a')).toBe('ready');

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through fetch failures', async () => {
    const fetchList = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{name: 'a', depsStatus: 'ready'}]);

    replaceDepsStatuses([{name: 'a', depsStatus: 'installing'}]);
    startDepsPolling({fetchList});

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getDepsStatus('a')).toBe('installing');

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getDepsStatus('a')).toBe('ready');
  });

  it('discards a response that resolves after stopDepsPolling', async () => {
    let resolveLate: (v: Array<{name: string; depsStatus: 'installing'}>) => void = () => {};
    const fetchList = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<Array<{name: string; depsStatus: 'installing'}>>((resolve) => {
          resolveLate = resolve;
        }),
    );

    replaceDepsStatuses([{name: 'a', depsStatus: 'installing'}]);
    startDepsPolling({fetchList});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    stopDepsPolling();
    replaceDepsStatuses([{name: 'b', depsStatus: 'installing'}]);

    resolveLate([{name: 'a', depsStatus: 'installing'}]);
    await vi.advanceTimersByTimeAsync(0);

    expect(getDepsStatus('b')).toBe('installing');
    expect(getDepsStatus('a')).toBe('ready');
  });
});
