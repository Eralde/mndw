// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';

import type {TickerRequest, TickerResponse} from './ticker.js';

interface PendingTimer {
  readonly callback: () => void;
  readonly delay: number;
}

interface FakeWorkerScope {
  clearTimeout(id: number): void;
  onmessage: ((event: MessageEvent<TickerRequest>) => void) | null;
  postMessage(message: TickerResponse): void;
  setTimeout(callback: () => void, delay: number): number;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ticker.worker', () => {
  it('corrects recursive timeout scheduling for drift and stops active timers', async () => {
    const timers = new Map<number, PendingTimer>();
    const cleared = vi.fn<(id: number) => void>((id) => {
      timers.delete(id);
    });
    const postMessage = vi.fn<(message: TickerResponse) => void>();
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
      .mockReturnValueOnce(2008);

    await import('./ticker.worker.js');

    scope.onmessage?.({data: {command: 'start', interval: 1000}} as MessageEvent<TickerRequest>);

    expect(timers.get(1)?.delay).toBe(1000);

    timers.get(1)?.callback();

    expect(postMessage).toHaveBeenCalledWith({type: 'tick', timestamp: 2008, drift: 8});
    expect(timers.get(2)?.delay).toBe(992);

    scope.onmessage?.({data: {command: 'stop'}} as MessageEvent<TickerRequest>);

    expect(cleared).toHaveBeenCalledWith(2);
    expect(timers.has(2)).toBe(false);
  });
});
