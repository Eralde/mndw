import {afterEach, describe, expect, it, vi} from 'vitest';

import {createRefreshLoop} from './refresh-loop.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRefreshLoop', () => {
  it('loads immediately, schedules one interval, and does not overlap loads', async () => {
    vi.useFakeTimers();

    const first = deferred<string>();
    const onSuccess = vi.fn();
    const load = vi.fn(() => first.promise);
    const loop = createRefreshLoop({load, intervalMs: 30_000, onSuccess, onError: vi.fn()});

    loop.start();
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(load).toHaveBeenCalledTimes(1);

    first.resolve('first');
    await flushPromises();

    expect(onSuccess).toHaveBeenCalledWith('first');
  });

  it('reports initial errors and recovers on a later interval refresh', async () => {
    vi.useFakeTimers();

    const first = deferred<string>();
    const retry = deferred<string>();
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const load = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    const loop = createRefreshLoop({load, intervalMs: 30_000, onSuccess, onError});

    loop.start();
    first.reject(new Error('initial failure'));
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), true);

    vi.advanceTimersByTime(30_000);
    expect(load).toHaveBeenCalledTimes(2);

    retry.resolve('recovered');
    await flushPromises();

    expect(onSuccess).toHaveBeenCalledWith('recovered');
  });

  it('stops future loads and suppresses callbacks from an in-flight result', async () => {
    vi.useFakeTimers();

    const pending = deferred<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const load = vi.fn(() => pending.promise);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const loop = createRefreshLoop({load, intervalMs: 30_000, onSuccess, onError});

    loop.start();
    loop.stop();
    loop.stop();
    vi.advanceTimersByTime(60_000);
    pending.resolve('stale');
    await flushPromises();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
