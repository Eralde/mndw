export {};

export type TickerRequest =
  | {command: 'start'; interval: number}
  | {command: 'stop'}
  | {command: 'setInterval'; interval: number};

export interface TickerResponse {
  readonly type: 'tick';
  readonly timestamp: number;
  readonly drift: number;
}

interface TickerWorkerScope {
  clearTimeout(timeoutId: number): void;
  onmessage: ((event: MessageEvent<TickerRequest>) => void) | null;
  postMessage(message: TickerResponse): void;
  setTimeout(callback: () => void, delay: number): number;
}

declare const self: TickerWorkerScope;

let interval = 1000;
let expected = 0;
let timeoutId: number | null = null;

const tick = (): void => {
  const now = performance.now();
  const drift = now - expected;

  self.postMessage({type: 'tick', timestamp: now, drift});

  expected += interval;
  timeoutId = self.setTimeout(tick, Math.max(0, interval - drift));
};

const stop = (): void => {
  if (timeoutId !== null) {
    self.clearTimeout(timeoutId);
    timeoutId = null;
  }
};

const start = (newInterval: number): void => {
  stop();
  interval = newInterval;
  expected = performance.now() + interval;
  timeoutId = self.setTimeout(tick, interval);
};

self.onmessage = (event: MessageEvent<TickerRequest>): void => {
  switch (event.data.command) {
    case 'start':
      start(event.data.interval);
      break;
    case 'stop':
      stop();
      break;
    case 'setInterval':
      interval = event.data.interval;
      break;
  }
};
