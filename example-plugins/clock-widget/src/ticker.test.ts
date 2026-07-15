// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TickerRequest, TickerResponse} from './ticker.worker';
import {Ticker} from './ticker';

class FakeWorker {
  public static readonly instances: FakeWorker[] = [];
  public onmessage: ((event: MessageEvent<TickerResponse>) => void) | null = null;
  public readonly messages: TickerRequest[] = [];
  public terminated = false;

  public constructor() {
    FakeWorker.instances.push(this);
  }

  public emit(response: TickerResponse): void {
    this.onmessage?.({data: response} as MessageEvent<TickerResponse>);
  }

  public postMessage(message: TickerRequest): void {
    this.messages.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ticker', () => {
  it('forwards lifecycle messages and tick responses while supporting unsubscribe and destroy', () => {
    const ticker = new Ticker();
    const callback = vi.fn();
    const unsubscribe = ticker.onTick(callback);
    const response: TickerResponse = {type: 'tick', timestamp: 123, drift: 4};
    const worker = FakeWorker.instances[0];

    ticker.start(1000);
    ticker.setInterval(500);
    worker?.emit(response);

    expect(worker?.messages).toEqual([
      {command: 'start', interval: 1000},
      {command: 'setInterval', interval: 500},
    ]);
    expect(callback).toHaveBeenCalledWith(response);

    unsubscribe();
    worker?.emit(response);
    ticker.stop();
    ticker.destroy();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(worker?.messages).toEqual([
      {command: 'start', interval: 1000},
      {command: 'setInterval', interval: 500},
      {command: 'stop'},
      {command: 'stop'},
    ]);
    expect(worker?.terminated).toBe(true);
  });
});
