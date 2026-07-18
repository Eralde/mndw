import type {TickerRequest, TickerResponse} from './ticker.worker';

type TickCallback = (payload: TickerResponse) => void;

export class Ticker {
  private readonly worker: Worker;
  private readonly callbacks = new Set<TickCallback>();

  public constructor() {
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
