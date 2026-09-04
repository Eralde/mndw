// @vitest-environment happy-dom
import type {PluginContext, ProjectedSnapshot} from '@mndw/sdk';
import {createTestI18n} from '@mndw/sdk/testing';
import type {RciManager, RciQuery} from '@rci-tools/core';
import {createApp, nextTick} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Observable, Subject, forkJoin, of, throwError} from 'rxjs';

import App from './App.vue';
import enCatalog from '../i18n/en.json';

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
const projectionEnd = 1_800_000_000_000;
const projectionStart = projectionEnd - 7 * 24 * 60 * 60 * 1000;

const projectedTelemetrySnapshot = (): ProjectedSnapshot => ({
  keys: {
    cpu: {
      label: 'CPU',
      supported: true,
      unit: 'percent',
      points: [{time: projectionStart, value: Number.NaN}, {time: projectionEnd, value: 25}],
      segments: [{data: [{time: 1_800_000_000_000, value: 25}]}],
      bands: [{id: 'range-0', data: [{time: 1_800_000_000_000, min: 20, max: 30}], color: 'accent'}],
      valueDomain: {min: 0, max: 100},
    },
    ram: {
      label: 'RAM',
      supported: true,
      unit: 'percent',
      points: [{time: projectionStart, value: Number.NaN}, {time: projectionEnd, value: 45}],
      segments: [{data: [{time: 1_800_000_000_000, value: 45}]}],
      bands: [{id: 'range-0', data: [{time: 1_800_000_000_000, min: 40, max: 50}], color: 'accent'}],
      valueDomain: {min: 0, max: 100},
    },
  },
  gathering: {enabled: true},
});

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

function createContext(
  queue: (query: RciQuery) => Observable<unknown>,
  i18n = createTestI18n(enCatalog),
  projected: ProjectedSnapshot = projectedTelemetrySnapshot(),
): PluginContext {
  return {
    hostInfo: {locale: 'en', theme: 'dark'},
    deviceInfo: {model: 'Keenetic Giga', firmwareVersion: '1.0.0'},
    rciManager: {
      queue: (query: RciQuery | RciQuery[]) =>
        Array.isArray(query)
          ? forkJoin(query.map((item) => queue(item)))
          : queue(query),
    } as unknown as RciManager,
    telemetry: {
      fetchAll: vi.fn().mockRejectedValue(new Error('fetchAll should not be called by App.vue')),
      fetchProjected: vi.fn().mockResolvedValue(projected),
    },
    storage: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
    },
    overlay: {open: vi.fn(), createLayer: vi.fn(), closeAll: vi.fn()},
    i18n,
  } as unknown as PluginContext;
}

function mountWidget(
  queue: (query: RciQuery) => Observable<unknown>,
  i18n = createTestI18n(enCatalog),
  projected: ProjectedSnapshot = projectedTelemetrySnapshot(),
): ReturnType<typeof createApp> {
  const host = document.createElement('div');

  document.body.append(host);

  const app = createApp(App, {ctx: createContext(queue, i18n, projected)});

  app.mount(host);

  return app;
}

function mountWidgetContext(ctx: PluginContext): {app: ReturnType<typeof createApp>; host: HTMLElement} {
  const host = document.createElement('div');

  document.body.append(host);

  const app = createApp(App, {ctx});

  app.mount(host);

  return {app, host};
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
  it('updates the same probe after a locale switch', async () => {
    const i18n = createTestI18n({l10n: {probe: 'Device English'}});
    const app = mountWidget(() => new Observable<unknown>(() => {}), i18n);
    const probe = document.querySelector<HTMLElement>('[data-testid="l10n-probe"]');

    expect(probe?.textContent).toBe('Device English');
    i18n.setLocale('ru', {l10n: {probe: 'Устройство русский'}});
    await nextTick();

    expect(document.querySelector('[data-testid="l10n-probe"]')).toBe(probe);
    expect(probe?.textContent).toBe('Устройство русский');
    app.unmount();
  });

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

    expect(document.querySelector('.mndw-alert--danger')).not.toBeNull();

    vi.advanceTimersByTime(30_000);
    await flushPromises();

    expect(document.querySelector('.mndw-alert--danger')).toBeNull();
    expect(document.body.textContent).toContain('Keenetic Giga');

    app.unmount();
  });

  it('uses LoadBarChart for CPU and RAM in durable ranges', async () => {
    const ctx = createContext(successfulResponse, createTestI18n(enCatalog), projectedTelemetrySnapshot());
    const {app, host} = mountWidgetContext(ctx);

    await flushPromises();

    const buttons = [...document.querySelectorAll('button')];
    const range7d = buttons.find((button) => button.textContent?.trim() === '7d');
    const range30d = buttons.find((button) => button.textContent?.trim() === '30d');

    range7d?.click();
    await flushPromises();

    expect(document.querySelectorAll('.load-bar-chart')).toHaveLength(2);

    const charts = [...host.querySelectorAll('mndw-sparkline')] as Array<HTMLElement & {
      timeDomain?: unknown;
    }>;

    expect(charts[0]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});
    expect(charts[1]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});
    await Promise.all(charts.map(async (chart) => {
      await (chart as HTMLElement & {updateComplete?: Promise<unknown>}).updateComplete;
    }));
    expect(charts[0]?.shadowRoot?.querySelectorAll('rect.bar')).toHaveLength(1);
    expect(charts[1]?.shadowRoot?.querySelectorAll('rect.bar')).toHaveLength(1);

    range30d?.click();
    await flushPromises();

    expect(document.querySelectorAll('.load-bar-chart')).toHaveLength(2);
    app.unmount();
    host.remove();
  });

  it('does not render a temperature section', async () => {
    const app = mountWidget(successfulResponse, createTestI18n(enCatalog), projectedTelemetrySnapshot());

    await flushPromises();

    expect(document.querySelectorAll('.load-bar-chart')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('Temperature');

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

  it('calls fetchProjected with 7d when switching to the 7d range', async () => {
    const fetchProjected = vi.fn().mockResolvedValue(projectedTelemetrySnapshot());
    const ctx = createContext(successfulResponse, createTestI18n(enCatalog));

    (ctx.telemetry as unknown as {fetchProjected: typeof fetchProjected}).fetchProjected = fetchProjected;

    const {app, host} = mountWidgetContext(ctx);

    await flushPromises();

    const buttons = host.querySelectorAll('.range-controls button');

    Array.from(buttons).find((button) => button.textContent?.includes('7d'))
      ?.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(fetchProjected).toHaveBeenCalledWith('7d', expect.objectContaining({signal: expect.any(AbortSignal)}));

    app.unmount();
    host.remove();
  });

  it('calls fetchProjected with 30d when switching to the 30d range', async () => {
    const fetchProjected = vi.fn().mockResolvedValue(projectedTelemetrySnapshot());
    const ctx = createContext(successfulResponse, createTestI18n(enCatalog));

    (ctx.telemetry as unknown as {fetchProjected: typeof fetchProjected}).fetchProjected = fetchProjected;

    const {app, host} = mountWidgetContext(ctx);

    await flushPromises();

    const buttons = host.querySelectorAll('.range-controls button');

    Array.from(buttons).find((button) => button.textContent?.includes('30d'))
      ?.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(fetchProjected).toHaveBeenCalledWith('30d', expect.objectContaining({signal: expect.any(AbortSignal)}));

    app.unmount();
    host.remove();
  });

  it('stops projected loop when switching back to a live range', async () => {
    const fetchProjected = vi.fn().mockResolvedValue(projectedTelemetrySnapshot());
    const ctx = createContext(successfulResponse, createTestI18n(enCatalog));

    (ctx.telemetry as unknown as {fetchProjected: typeof fetchProjected}).fetchProjected = fetchProjected;

    const {app, host} = mountWidgetContext(ctx);

    await flushPromises();

    const buttons = host.querySelectorAll('.range-controls button');

    Array.from(buttons).find((button) => button.textContent?.includes('7d'))
      ?.dispatchEvent(new Event('click'));
    await flushPromises();

    const callCount = fetchProjected.mock.calls.length;

    Array.from(buttons).find((button) => button.textContent?.includes('3m'))
      ?.dispatchEvent(new Event('click'));
    await flushPromises();

    vi.advanceTimersByTime(16 * 60_000);
    await flushPromises();

    expect(fetchProjected.mock.calls.length).toBe(callCount);

    app.unmount();
    host.remove();
  });

  it('does not render stale 7d projection as 30d while 30d fetch is in flight', async () => {
    let resolveFirst: ((value: ProjectedSnapshot) => void) | undefined;
    let resolveSecond: ((value: ProjectedSnapshot) => void) | undefined;
    const fetchProjected = vi.fn()
      .mockReturnValueOnce(
        new Promise<ProjectedSnapshot>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ProjectedSnapshot>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const ctx = createContext(successfulResponse, createTestI18n(enCatalog));

    (ctx.telemetry as unknown as {fetchProjected: typeof fetchProjected}).fetchProjected = fetchProjected;

    const {app, host} = mountWidgetContext(ctx);

    await flushPromises();

    const buttons = host.querySelectorAll('.range-controls button');

    Array.from(buttons).find((button) => button.textContent?.includes('7d'))
      ?.dispatchEvent(new Event('click'));
    await flushPromises();
    resolveFirst?.(projectedTelemetrySnapshot());
    await flushPromises();

    const charts = [...host.querySelectorAll('mndw-sparkline')] as Array<HTMLElement & {
      timeDomain?: unknown;
    }>;

    expect(charts[0]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});
    expect(charts[1]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});

    Array.from(buttons).find((button) => button.textContent?.includes('30d'))
      ?.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(charts[0]?.timeDomain).toBeUndefined();
    expect(charts[1]?.timeDomain).toBeUndefined();

    resolveSecond?.(projectedTelemetrySnapshot());
    await flushPromises();
    expect(charts[0]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});
    expect(charts[1]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});

    app.unmount();
    host.remove();
  });
});
