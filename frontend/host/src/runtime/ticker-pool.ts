import {Subject, Subscription} from 'rxjs';
import type {Ticker, TickerTick} from '@mndw/sdk';
import type {PluginLifetime} from './plugin-lifetime.js';

export type TickerPoolRequest =
  | {readonly command: 'start'; readonly id: number; readonly interval: number}
  | {readonly command: 'setInterval'; readonly id: number; readonly interval: number}
  | {readonly command: 'stop'; readonly id: number};

export interface TickerPoolResponse extends TickerTick {
  readonly type: 'tick';
  readonly id: number;
}

export interface TickerWorkerPort {
  onmessage: ((event: MessageEvent<TickerPoolResponse>) => void) | null;
  postMessage(message: TickerPoolRequest): void;
  terminate(): void;
}

export interface TickerPool {
  create(lifetime: PluginLifetime): Ticker;
}

interface TickerHandle {
  readonly id: number;
  readonly subject: Subject<TickerTick>;
  running: boolean;
  destroyed: boolean;
  interval: number;
}

type WorkerFactory = () => TickerWorkerPort;

const createWorker: WorkerFactory = () => {
  return new Worker(new URL('./ticker-pool.worker.ts', import.meta.url), {type: 'module'});
};

export function createTickerPool(workerFactory: WorkerFactory = createWorker): TickerPool {
  const handles = new Map<number, TickerHandle>();
  let nextId = 1;
  let worker: TickerWorkerPort | undefined;

  const runningCount = (): number => {
    let count = 0;

    for (const handle of handles.values()) {
      if (handle.running && !handle.destroyed) {
        count += 1;
      }
    }

    return count;
  };

  const terminateWorkerIfIdle = (): void => {
    if (runningCount() !== 0 || worker === undefined) {
      return;
    }

    const currentWorker = worker;

    worker = undefined;
    currentWorker.onmessage = null;
    currentWorker.terminate();
  };

  const ensureWorker = (): TickerWorkerPort => {
    if (worker !== undefined) {
      return worker;
    }

    const currentWorker = workerFactory();

    currentWorker.onmessage = (event): void => {
      const handle = handles.get(event.data.id);

      if (handle !== undefined && handle.running && !handle.destroyed) {
        handle.subject.next({timestamp: event.data.timestamp, drift: event.data.drift});
      }
    };
    worker = currentWorker;

    return currentWorker;
  };

  const createHandle = (lifetime: PluginLifetime): Ticker => {
    const handle: TickerHandle = {
      id: nextId++,
      subject: new Subject<TickerTick>(),
      running: false,
      destroyed: false,
      interval: 1000,
    };

    handles.set(handle.id, handle);

    const lifetimeSubscription = new Subscription();

    const destroy = (): void => {
      if (handle.destroyed) {
        return;
      }

      if (handle.running) {
        handle.running = false;
        worker?.postMessage({command: 'stop', id: handle.id});
      }

      handle.destroyed = true;
      handles.delete(handle.id);
      lifetimeSubscription.unsubscribe();
      handle.subject.complete();
      terminateWorkerIfIdle();
    };

    lifetimeSubscription.add(lifetime.ended$.subscribe(destroy));

    return {
      start: (intervalMs): void => {
        if (handle.destroyed) {
          return;
        }

        handle.interval = intervalMs;
        handle.running = true;
        ensureWorker().postMessage({command: 'start', id: handle.id, interval: intervalMs});
      },
      setInterval: (intervalMs): void => {
        if (handle.destroyed) {
          return;
        }

        handle.interval = intervalMs;

        if (worker !== undefined) {
          worker.postMessage({command: 'setInterval', id: handle.id, interval: intervalMs});
        }
      },
      stop: (): void => {
        if (handle.destroyed || !handle.running) {
          return;
        }

        handle.running = false;
        worker?.postMessage({command: 'stop', id: handle.id});
        terminateWorkerIfIdle();
      },
      tick$: handle.subject.asObservable(),
      destroy,
    };
  };

  return Object.freeze({create: createHandle});
}

export const hostTickerPool: TickerPool = createTickerPool();
