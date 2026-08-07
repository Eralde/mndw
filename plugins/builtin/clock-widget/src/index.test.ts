// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginContext} from '@mndw/sdk';
import type {TickerRequest, TickerResponse} from '@mndw/sdk/ticker';
import {createInstance} from './index';

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-15T12:34:56'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createInstance', () => {
  it('keeps immediate rendering while using worker ticks and cleaning up on unmount', () => {
    const host = document.createElement('div');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const instance = createInstance(host, {} as PluginContext);
    const worker = FakeWorker.instances[0];

    expect(host.querySelector<HTMLTimeElement>('[data-mndw-clock]')?.textContent)
      .toBe(new Date().toLocaleTimeString());
    expect(worker?.messages).toEqual([{command: 'start', interval: 1000}]);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    worker?.emit({type: 'tick', timestamp: 1000, drift: 0});

    expect(host.querySelector<HTMLTimeElement>('[data-mndw-clock]')?.textContent)
      .toBe(new Date().toLocaleTimeString());

    instance.unmount();

    expect(worker?.messages).toEqual([{command: 'start', interval: 1000}, {command: 'stop'}]);
    expect(worker?.terminated).toBe(true);
    expect(host.innerHTML).toBe('');
  });
});
