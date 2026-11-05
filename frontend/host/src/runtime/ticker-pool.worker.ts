import type {TickerPoolRequest, TickerPoolResponse} from './ticker-pool.js';

interface TickerWorkerScope {
  clearTimeout(timeoutId: number): void;
  onmessage: ((event: MessageEvent<TickerPoolRequest>) => void) | null;
  postMessage(message: TickerPoolResponse): void;
  setTimeout(callback: () => void, delay: number): number;
}

interface TimerState {
  interval: number;
  expected: number;
  timeoutId: number | null;
}

declare const self: TickerWorkerScope;

const timers = new Map<number, TimerState>();

const stop = (id: number): void => {
  const timer = timers.get(id);

  if (timer === undefined) {
    return;
  }

  if (timer.timeoutId !== null) {
    self.clearTimeout(timer.timeoutId);
    timer.timeoutId = null;
  }

  timers.delete(id);
};

const start = (id: number, interval: number): void => {
  stop(id);

  const timer: TimerState = {interval, expected: performance.now() + interval, timeoutId: null};
  const tick = (): void => {
    if (timers.get(id) !== timer) {
      return;
    }

    const now = performance.now();
    const drift = now - timer.expected;

    self.postMessage({type: 'tick', id, timestamp: now, drift});
    timer.expected += timer.interval;
    timer.timeoutId = self.setTimeout(tick, Math.max(0, timer.interval - drift));
  };

  timers.set(id, timer);
  timer.timeoutId = self.setTimeout(tick, interval);
};

self.onmessage = (event: MessageEvent<TickerPoolRequest>): void => {
  switch (event.data.command) {
    case 'start':
      start(event.data.id, event.data.interval);
      break;
    case 'stop':
      stop(event.data.id);
      break;
    case 'setInterval': {
      const timer = timers.get(event.data.id);

      if (timer !== undefined) {
        timer.interval = event.data.interval;
      }

      break;
    }
  }
};
