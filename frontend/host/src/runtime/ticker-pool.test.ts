import {config} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';
import {createPluginLifetime} from './plugin-lifetime.js';
import {
  type TickerPoolRequest,
  type TickerPoolResponse,
  type TickerWorkerPort,
  createTickerPool,
} from './ticker-pool.js';

class FakeTickerWorker implements TickerWorkerPort {
  public readonly messages: TickerPoolRequest[] = [];
  public onmessage: ((event: MessageEvent<TickerPoolResponse>) => void) | null = null;
  public terminated = false;

  public postMessage(message: TickerPoolRequest): void {
    this.messages.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public emit(response: TickerPoolResponse): void {
    this.onmessage?.({data: response} as MessageEvent<TickerPoolResponse>);
  }
}

function createPool(): {pool: ReturnType<typeof createTickerPool>; workers: FakeTickerWorker[]} {
  const workers: FakeTickerWorker[] = [];
  const pool = createTickerPool(() => {
    const worker = new FakeTickerWorker();

    workers.push(worker);

    return worker;
  });

  return {pool, workers};
}

describe('ticker pool', () => {
  it('runs one worker for many handles, each with its own interval', () => {
    const {pool, workers} = createPool();
    const first = pool.create(createPluginLifetime());
    const second = pool.create(createPluginLifetime());
    const firstTicks: number[] = [];
    const secondTicks: number[] = [];

    first.tick$.subscribe((tick) => firstTicks.push(tick.timestamp));
    second.tick$.subscribe((tick) => secondTicks.push(tick.timestamp));
    first.start(1000);
    first.setInterval(750);
    second.start(250);

    expect(workers).toHaveLength(1);
    expect(workers[0]?.messages).toEqual([
      {command: 'start', id: 1, interval: 1000},
      {command: 'setInterval', id: 1, interval: 750},
      {command: 'start', id: 2, interval: 250},
    ]);

    workers[0]?.emit({type: 'tick', id: 1, timestamp: 100, drift: 2});
    workers[0]?.emit({type: 'tick', id: 2, timestamp: 200, drift: 3});

    expect(firstTicks).toEqual([100]);
    expect(secondTicks).toEqual([200]);
  });

  it('stop and destroy affect only their own handle', () => {
    const {pool, workers} = createPool();
    const first = pool.create(createPluginLifetime());
    const second = pool.create(createPluginLifetime());
    const firstComplete = vi.fn();
    const secondTicks: number[] = [];

    first.tick$.subscribe({complete: firstComplete});
    second.tick$.subscribe((tick) => secondTicks.push(tick.timestamp));
    first.start(1000);
    second.start(500);
    first.stop();

    const firstId = workers[0]?.messages[0]?.command === 'start' ? workers[0].messages[0].id : -1;
    const secondId = workers[0]?.messages[1]?.command === 'start' ? workers[0].messages[1].id : -1;

    expect(workers[0]?.messages[2]).toEqual({command: 'stop', id: firstId});
    expect(workers[0]?.terminated).toBe(false);
    first.destroy();
    workers[0]?.emit({type: 'tick', id: firstId, timestamp: 100, drift: 0});
    workers[0]?.emit({type: 'tick', id: secondId, timestamp: 200, drift: 0});

    expect(firstComplete).toHaveBeenCalledOnce();
    expect(secondTicks).toEqual([200]);
    expect(workers[0]?.terminated).toBe(false);

    second.stop();

    expect(workers[0]?.terminated).toBe(true);
  });

  it('treats double destroy, start after destroy and stop before start as no-ops', () => {
    const {pool, workers} = createPool();
    const ticker = pool.create(createPluginLifetime());
    const complete = vi.fn();

    ticker.tick$.subscribe({complete});
    ticker.stop();
    ticker.destroy();
    ticker.destroy();
    ticker.start(1000);
    ticker.setInterval(250);

    expect(workers).toHaveLength(0);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('keeps ticking other subscribers and handles when one subscriber throws', async () => {
    const previousHandler = config.onUnhandledError;
    const unhandledError = vi.fn();
    const {pool, workers} = createPool();
    const first = pool.create(createPluginLifetime());
    const second = pool.create(createPluginLifetime());
    const firstHealthy = vi.fn();
    const secondHealthy = vi.fn();

    config.onUnhandledError = unhandledError;

    try {
      first.tick$.subscribe(() => {
        throw new Error('ticker subscriber failed');
      });
      first.tick$.subscribe(firstHealthy);
      second.tick$.subscribe(secondHealthy);
      first.start(1000);
      second.start(500);

      const firstId = workers[0]?.messages[0]?.command === 'start' ? workers[0].messages[0].id : -1;
      const secondId = workers[0]?.messages[1]?.command === 'start' ? workers[0].messages[1].id : -1;

      workers[0]?.emit({type: 'tick', id: firstId, timestamp: 100, drift: 0});
      workers[0]?.emit({type: 'tick', id: secondId, timestamp: 200, drift: 0});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(firstHealthy).toHaveBeenCalledOnce();
      expect(secondHealthy).toHaveBeenCalledOnce();
      expect(unhandledError).toHaveBeenCalledWith(expect.objectContaining({message: 'ticker subscriber failed'}));
    } finally {
      config.onUnhandledError = previousHandler;
    }
  });

  it('destroys every handle of a plugin when its lifetime ends', () => {
    const {pool, workers} = createPool();
    const lifetime = createPluginLifetime();
    const first = pool.create(lifetime);
    const second = pool.create(lifetime);
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();

    first.tick$.subscribe({complete: firstComplete});
    second.tick$.subscribe({complete: secondComplete});
    first.start(1000);
    second.start(500);
    lifetime.end();

    expect(workers[0]?.messages.slice(2)).toEqual([
      {command: 'stop', id: 1},
      {command: 'stop', id: 2},
    ]);
    expect(workers[0]?.terminated).toBe(true);
    expect(firstComplete).toHaveBeenCalledOnce();
    expect(secondComplete).toHaveBeenCalledOnce();
  });

  it('terminates the worker when no handle runs, and recreates it on the next start', () => {
    const {pool, workers} = createPool();
    const ticker = pool.create(createPluginLifetime());

    ticker.start(1000);
    ticker.stop();

    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminated).toBe(true);

    ticker.start(500);

    expect(workers).toHaveLength(2);
    expect(workers[1]?.messages).toEqual([{command: 'start', id: 1, interval: 500}]);
    expect(workers[1]?.terminated).toBe(false);
  });
});
