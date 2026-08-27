export type TickerRequest =
  | {command: 'start'; interval: number}
  | {command: 'stop'}
  | {command: 'setInterval'; interval: number};

export interface TickerResponse {
  readonly type: 'tick';
  readonly timestamp: number;
  readonly drift: number;
}

type TickCallback = (payload: TickerResponse) => void;

/** Drift-corrected ticker that runs its scheduling loop in a dedicated WebWorker. */
export class Ticker {
  private readonly worker: Worker;
  private readonly callbacks = new Set<TickCallback>();

  constructor() {
    this.worker = new Worker(new URL('./ticker.worker.ts', import.meta.url), {type: 'module'});
    this.worker.onmessage = (event: MessageEvent<TickerResponse>): void => {
      if (event.data.type === 'tick') {
        for (const callback of this.callbacks) {
          callback(event.data);
        }
      }
    };
  }

  public start(intervalMs: number): void {
    this.worker.postMessage({command: 'start', interval: intervalMs} as TickerRequest);
  }

  public setInterval(intervalMs: number): void {
    this.worker.postMessage({command: 'setInterval', interval: intervalMs} as TickerRequest);
  }

  public stop(): void {
    this.worker.postMessage({command: 'stop'} as TickerRequest);
  }

  public onTick(callback: TickCallback): () => void {
    this.callbacks.add(callback);

    return (): void => {
      this.callbacks.delete(callback);
    };
  }

  public destroy(): void {
    this.stop();
    this.worker.terminate();
    this.callbacks.clear();
  }
}
