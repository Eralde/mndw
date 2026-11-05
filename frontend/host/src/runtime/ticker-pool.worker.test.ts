// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {TickerPoolRequest, TickerPoolResponse} from './ticker-pool.js';

interface PendingTimer {
  readonly callback: () => void;
  readonly delay: number;
}

interface FakeWorkerScope {
  clearTimeout(id: number): void;
  onmessage: ((event: MessageEvent<TickerPoolRequest>) => void) | null;
  postMessage(message: TickerPoolResponse): void;
  setTimeout(callback: () => void, delay: number): number;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ticker-pool.worker', () => {
  it('corrects drift independently for each timer and stops only the requested timer', async () => {
    const timers = new Map<number, PendingTimer>();
    const cleared = vi.fn<(id: number) => void>((id) => {
      timers.delete(id);
    });
    const postMessage = vi.fn<(message: TickerPoolResponse) => void>();
    let nextTimerId = 1;
    const scope: FakeWorkerScope = {
      clearTimeout: cleared,
      onmessage: null,
      postMessage,
      setTimeout: (callback, delay) => {
        const id = nextTimerId++;

        timers.set(id, {callback, delay});

        return id;
      },
    };

    vi.stubGlobal('self', scope);
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2008)
      .mockReturnValueOnce(4005);

    await import('./ticker-pool.worker.js');

    scope.onmessage?.({data: {command: 'start', id: 1, interval: 1000}} as MessageEvent<TickerPoolRequest>);
    scope.onmessage?.({data: {command: 'start', id: 2, interval: 2000}} as MessageEvent<TickerPoolRequest>);

    expect(timers.get(1)?.delay).toBe(1000);
    expect(timers.get(2)?.delay).toBe(2000);

    timers.get(1)?.callback();
    timers.get(2)?.callback();

    expect(postMessage).toHaveBeenNthCalledWith(1, {type: 'tick', id: 1, timestamp: 2008, drift: 8});
    expect(postMessage).toHaveBeenNthCalledWith(2, {type: 'tick', id: 2, timestamp: 4005, drift: 5});
    expect(timers.get(3)?.delay).toBe(992);
    expect(timers.get(4)?.delay).toBe(1995);

    scope.onmessage?.({data: {command: 'stop', id: 1}} as MessageEvent<TickerPoolRequest>);

    expect(cleared).toHaveBeenCalledWith(3);
    expect(timers.has(3)).toBe(false);
    expect(timers.has(4)).toBe(true);
  });
});
