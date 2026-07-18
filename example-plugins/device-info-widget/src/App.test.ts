// @vitest-environment happy-dom
import type {PluginContext} from '@mndw/sdk';
import type {RciManager, RciQuery} from '@rci-tools/core';
import {createApp, nextTick} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type Observable, Subject, of, throwError} from 'rxjs';

import App from './App.vue';

interface FakeWorkerInstance {
  messages: unknown[];
  terminated: boolean;
}

class FakeWorker {
  public static readonly instances: FakeWorkerInstance[] = [];
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public readonly messages: unknown[] = [];
  public terminated = false;

  public constructor() {
    FakeWorker.instances.push(this);
  }

  public postMessage(message: unknown): void {
    this.messages.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }
}

class FakeResizeObserver {
  public observe(_element: Element): void {}

  public disconnect(): void {}
}

const identification = {servicetag: 'ST', serial: 'SN', mac: 'AA:BB', hwid: 'HW', cid: 'CID'};
const system = {model: 'Keenetic Giga', uptime: 61, cpuload: 27, memtotal: 1000, memory: '610/1024'};

function successfulResponse(query: RciQuery): Observable<unknown> {
  switch (query.path) {
    case 'show.identification':
      return of(identification);
    case 'show.system':
      return of(system);
    case 'show.system.rrd.cpu':
      return of({data: [{t: '1', v: 21}]});
    case 'show.system.rrd.memory':
      return of({data: [{t: 1, v: 620}]});
    default:
      return throwError(() => new Error(`unexpected query: ${query.path}`));
  }
}

function createContext(queue: (query: RciQuery) => Observable<unknown>): PluginContext {
  return {
    hostInfo: {firmwareVersion: '1.0.0', deviceName: 'Router'},
    rciManager: {queue} as unknown as RciManager,
  } as unknown as PluginContext;
}

function mountWidget(queue: (query: RciQuery) => Observable<unknown>): ReturnType<typeof createApp> {
  const host = document.createElement('div');

  document.body.append(host);

  const app = createApp(App, {ctx: createContext(queue)});

  app.mount(host);

  return app;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }

  await nextTick();
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('App', () => {
  it('renders uptime, current load values, and both charts after a successful mount', async () => {
    const app = mountWidget(successfulResponse);

    await flushPromises();

    expect(document.body.textContent).toContain('1 minute, 1 second');
    expect(document.body.textContent).toContain('CPU');
    expect(document.body.textContent).toContain('27%');
    expect(document.body.textContent).toContain('RAM');
    expect(document.body.textContent).toContain('61%');
    expect(document.querySelectorAll('.load-bar-chart')).toHaveLength(2);

    app.unmount();
  });

  it('recovers from an initial failure on the next 30-second refresh', async () => {
    let systemAttempts = 0;
    const queue = (query: RciQuery): Observable<unknown> => {
      if (query.path === 'show.system') {
        systemAttempts += 1;

        return systemAttempts === 1
          ? throwError(() => new Error('initial failure'))
          : of(system);
      }

      return successfulResponse(query);
    };
    const app = mountWidget(queue);

    await flushPromises();

    expect(document.querySelector('.app__error')).not.toBeNull();

    vi.advanceTimersByTime(30_000);
    await flushPromises();

    expect(document.querySelector('.app__error')).toBeNull();
    expect(document.body.textContent).toContain('Keenetic Giga');

    app.unmount();
  });

  it('cleans up timers and worker and ignores a deferred response after unmount', async () => {
    const identificationSubject = new Subject<unknown>();
    const systemSubject = new Subject<unknown>();
    const queue = vi.fn((query: RciQuery): Observable<unknown> => {
      switch (query.path) {
        case 'show.identification':
          return identificationSubject.asObservable();
        case 'show.system':
          return systemSubject.asObservable();
        default:
          return of({data: []});
      }
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const app = mountWidget(queue);

    await flushPromises();

    app.unmount();

    const callsAtUnmount = queue.mock.calls.length;

    vi.advanceTimersByTime(30_000);
    identificationSubject.next(identification);
    identificationSubject.complete();
    systemSubject.next(system);
    systemSubject.complete();
    await flushPromises();

    expect(queue).toHaveBeenCalledTimes(callsAtUnmount);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
});
