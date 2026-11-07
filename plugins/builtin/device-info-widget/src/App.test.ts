// @vitest-environment happy-dom
import type {PluginContext, PluginRciManager, ProjectedSnapshot, TickerTick} from '@mndw/sdk';
import {createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import type {RciQuery} from '@rci-tools/core';
import {createApp, nextTick} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Observable, Subject, forkJoin, of, throwError} from 'rxjs';

import App from './App.vue';
import enCatalog from '../i18n/en.json';

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
  tickerFactory?: PluginContext['createTicker'],
): PluginContext {
  const fixture = createTestPluginContext({
    i18n,
    theme: 'dark',
    rciManager: {
      queue: (query: RciQuery | RciQuery[]) =>
        Array.isArray(query)
          ? forkJoin(query.map((item) => queue(item)))
          : queue(query),
    } as unknown as Partial<PluginRciManager>,
  });
  const context = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(fixture.context);

  for (const descriptor of Object.values(descriptors)) {
    descriptor.configurable = true;
  }

  Object.defineProperties(context, descriptors);
  Object.defineProperties(context, {
    deviceInfo: {enumerable: true,
      value: {...fixture.context.deviceInfo, model: 'Keenetic Giga', firmwareVersion: '1.0.0'}},
    telemetry: {
      enumerable: true,
      value: {
        fetchProjected: vi.fn().mockResolvedValue(projected),
      },
    },
    ...(tickerFactory === undefined ? {} : {createTicker: {enumerable: true, value: tickerFactory}}),
  });

  return Object.freeze(context) as unknown as PluginContext;
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

function changeRange(root: ParentNode, range: string): void {
  const segmented = root.querySelector<HTMLElement>('mndw-segmented');

  if (segmented === null) {
    throw new Error('range segmented control was not rendered');
  }

  segmented.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: range}}));
}

function getRangeSegment(root: ParentNode, range: string): Element | null {
  return root.querySelector(`mndw-segment[value="${range}"]`);
}

beforeEach(() => {
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
  it('marks the default range selected and follows later range changes', async () => {
    const app = mountWidget(successfulResponse);

    await flushPromises();

    expect(getRangeSegment(document, '3m')?.getAttribute('aria-checked')).toBe('true');
    expect(getRangeSegment(document, '1h')?.getAttribute('aria-checked')).toBe('false');

    changeRange(document, '1h');
    await flushPromises();

    expect(getRangeSegment(document, '3m')?.getAttribute('aria-checked')).toBe('false');
    expect(getRangeSegment(document, '1h')?.getAttribute('aria-checked')).toBe('true');

    app.unmount();
  });

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

  it('loads only selected live history and shows chart loading while changing range', async () => {
    const queries: RciQuery[] = [];
    const oneHourCpu = new Subject<unknown>();
    const oneHourMemory = new Subject<unknown>();
    const queue = vi.fn((query: RciQuery): Observable<unknown> => {
      queries.push(query);

      const detail = (query.data as {detail?: number} | undefined)?.detail;

      if (detail === 1 && query.path === 'show.system.rrd.cpu') {
        return oneHourCpu.asObservable();
      }

      if (detail === 1 && query.path === 'show.system.rrd.memory') {
        return oneHourMemory.asObservable();
      }

      return successfulResponse(query);
    });
    const app = mountWidget(queue);

    await flushPromises();

    expect(queries.filter((query) => query.path.startsWith('show.system.rrd.'))).toEqual([
      {path: 'show.system.rrd.cpu', data: {detail: 0, attribute: 'avg'}},
      {path: 'show.system.rrd.memory', data: {detail: 0, attribute: 'used'}},
    ]);

    changeRange(document, '1h');
    await flushPromises();

    expect(document.querySelectorAll('[data-testid="history-loading"]')).toHaveLength(2);
    expect(queries.slice(-2)).toEqual([
      {path: 'show.system.rrd.cpu', data: {detail: 1, attribute: 'avg'}},
      {path: 'show.system.rrd.memory', data: {detail: 1, attribute: 'used'}},
    ]);

    oneHourCpu.next({data: [{t: 2, v: 24}]});
    oneHourCpu.complete();
    oneHourMemory.next({data: [{t: 2, v: 450}]});
    oneHourMemory.complete();
    await flushPromises();

    expect(document.querySelectorAll('[data-testid="history-loading"]')).toHaveLength(0);
    expect(document.querySelectorAll('mndw-sparkline')).toHaveLength(2);

    app.unmount();
  });

  it('ignores a late response for a previously selected live range', async () => {
    const pending = {
      oneHour: {cpu: new Subject<unknown>(), memory: new Subject<unknown>()},
      threeHours: {cpu: new Subject<unknown>(), memory: new Subject<unknown>()},
    };
    const queue = vi.fn((query: RciQuery): Observable<unknown> => {
      const detail = (query.data as {detail?: number} | undefined)?.detail;
      const pendingRange = detail === 1 ? pending.oneHour : detail === 2 ? pending.threeHours : null;

      if (pendingRange !== null && query.path === 'show.system.rrd.cpu') {
        return pendingRange.cpu.asObservable();
      }

      if (pendingRange !== null && query.path === 'show.system.rrd.memory') {
        return pendingRange.memory.asObservable();
      }

      return successfulResponse(query);
    });
    const app = mountWidget(queue);

    await flushPromises();

    changeRange(document, '1h');
    await flushPromises();
    changeRange(document, '3h');
    await flushPromises();

    pending.oneHour.cpu.next({data: [{t: 2, v: 24}]});
    pending.oneHour.cpu.complete();
    pending.oneHour.memory.next({data: [{t: 2, v: 450}]});
    pending.oneHour.memory.complete();
    await flushPromises();

    expect(document.querySelectorAll('[data-testid="history-loading"]')).toHaveLength(2);

    pending.threeHours.cpu.next({data: [{t: 3, v: 26}]});
    pending.threeHours.cpu.complete();
    pending.threeHours.memory.next({data: [{t: 3, v: 475}]});
    pending.threeHours.memory.complete();
    await flushPromises();

    expect(document.querySelectorAll('[data-testid="history-loading"]')).toHaveLength(0);
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

    changeRange(document, '7d');
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

    changeRange(document, '30d');
    await flushPromises();

    expect(document.querySelectorAll('.load-bar-chart')).toHaveLength(2);
    app.unmount();
    host.remove();
  });

  it('keeps live refreshes on the last live detail while a durable range is selected', async () => {
    const queries: RciQuery[] = [];
    const queue = vi.fn((query: RciQuery): Observable<unknown> => {
      queries.push(query);

      return successfulResponse(query);
    });
    const app = mountWidget(queue);

    await flushPromises();

    changeRange(document, '1h');
    await flushPromises();

    changeRange(document, '7d');
    await flushPromises();
    expect(getRangeSegment(document, '7d')?.getAttribute('aria-checked')).toBe('true');

    vi.advanceTimersByTime(30_000);
    await flushPromises();

    expect(queries.slice(-2)).toEqual([
      {path: 'show.system.rrd.cpu', data: {detail: 1, attribute: 'avg'}},
      {path: 'show.system.rrd.memory', data: {detail: 1, attribute: 'used'}},
    ]);

    app.unmount();
  });

  it('does not render a temperature section', async () => {
    const app = mountWidget(successfulResponse, createTestI18n(enCatalog), projectedTelemetrySnapshot());

    await flushPromises();

    expect(document.querySelectorAll('.load-bar-chart')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('Temperature');

    app.unmount();
  });

  it('cleans up timers and ticker and ignores a deferred response after unmount', async () => {
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
    const tickerSubject = new Subject<TickerTick>();
    const ticker = {
      start: vi.fn((_intervalMs: number): void => {}),
      setInterval: vi.fn((_intervalMs: number): void => {}),
      stop: vi.fn((): void => {}),
      tick$: tickerSubject.asObservable(),
      destroy: vi.fn((): void => tickerSubject.complete()),
    };
    const tickerFactory = vi.fn(() => ticker);
    const {app} = mountWidgetContext(
      createContext(queue, createTestI18n(enCatalog), projectedTelemetrySnapshot(), tickerFactory),
    );

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
    expect(tickerFactory).toHaveBeenCalledOnce();
    expect(ticker.destroy).toHaveBeenCalledOnce();
  });

  it('calls fetchProjected with 7d when switching to the 7d range', async () => {
    const fetchProjected = vi.fn().mockResolvedValue(projectedTelemetrySnapshot());
    const ctx = createContext(successfulResponse, createTestI18n(enCatalog));

    (ctx.telemetry as unknown as {fetchProjected: typeof fetchProjected}).fetchProjected = fetchProjected;

    const {app, host} = mountWidgetContext(ctx);

    await flushPromises();

    changeRange(host, '7d');
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

    changeRange(host, '30d');
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

    changeRange(host, '7d');
    await flushPromises();

    const callCount = fetchProjected.mock.calls.length;

    changeRange(host, '3m');
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

    changeRange(host, '7d');
    await flushPromises();
    resolveFirst?.(projectedTelemetrySnapshot());
    await flushPromises();

    const charts = [...host.querySelectorAll('mndw-sparkline')] as Array<HTMLElement & {
      timeDomain?: unknown;
    }>;

    expect(charts[0]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});
    expect(charts[1]?.timeDomain).toEqual({start: projectionStart, end: projectionEnd});

    changeRange(host, '30d');
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
