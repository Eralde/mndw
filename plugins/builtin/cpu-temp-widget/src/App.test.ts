// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type App as VueApp, createApp, nextTick} from 'vue';
import type {PluginTelemetry, TelemetryGathering} from '@mndw/sdk';
import {type TestPluginContext, createTestI18n, createTestPluginContext} from '@mndw/sdk/testing';
import App from './App.vue';

let host: HTMLElement;
let app: VueApp | null = null;
let fixture: TestPluginContext | null = null;

const supportedSnapshot = (
  start: number,
  end: number,
  options: {gatheringEnabled?: boolean; sessionConfigured?: boolean} = {},
) => {
  return {
    keys: {
      temp: {
        supported: true,
        unit: 'celsius' as const,
        points: [{time: start, value: 50}, {time: end, value: 52}],
        segments: [{data: [{time: start, value: 50}, {time: end, value: 52}]}],
        bands: [],
        valueDomain: {min: 45, max: 55},
      },
    },
    gathering: {enabled: options.gatheringEnabled ?? true},
    sessionConfigured: options.sessionConfigured ?? true,
  };
};

function createGatheringStream(): {
  gathering$: PluginTelemetry['gathering$'];
  emit(enabled: boolean): void;
} {
  const observers = new Set<(value: TelemetryGathering) => void>();
  const source = {
    subscribe: (
      observer: ((value: TelemetryGathering) => void) | {next(value: TelemetryGathering): void},
    ): {unsubscribe(): void} => {
      const listener = typeof observer === 'function' ? observer : (value: TelemetryGathering) => observer.next(value);

      observers.add(listener);

      return {
        unsubscribe: (): void => {
          observers.delete(listener);
        },
      };
    },
    pipe: (..._operators: unknown[]): unknown => source,
  };

  return {
    gathering$: source as unknown as PluginTelemetry['gathering$'],
    emit: (enabled): void => {
      for (const observer of [...observers]) {
        observer({enabled});
      }
    },
  };
}

afterEach(() => {
  app?.unmount();
  app = null;
  fixture?.unmount();
  fixture = null;
  host?.remove();
  vi.useRealTimers();
});

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }

  await nextTick();
}

function mountApp(
  overrides: {
    telemetry?: Partial<PluginTelemetry>;
    setTileTitle?: (title: string) => void;
    i18n?: ReturnType<typeof createTestI18n>;
  } = {},
): TestPluginContext {
  host = document.createElement('div');
  host.style.height = '190px';

  document.body.append(host);

  fixture = createTestPluginContext({
    i18n: overrides.i18n ?? createTestI18n({
      'title': 'CPU temperature',
      'loading': 'Loading…',
      'empty': 'Gathering data…',
      'error': 'Error',
      'stale.message': 'Not updated since {time}',
      'stale.retry': 'Retry',
      'unsupported': 'Unsupported',
      'range-1h': '1H',
      'range-3h': '3H',
      'range-1d': '1D',
      'range-7d': '7D',
      'range-30d': '30D',
      'history-range': 'History range',
      'history-catching-up': 'Catching up…',
      'history-historical': 'Historical',
      'telemetry-note.off-with-data': 'Telemetry collection is off. The chart shows data up to {time}.',
      'telemetry-note.off': 'Telemetry collection is off.',
      'telemetry-note.link': 'Turn it on in settings',
      'telemetry-note.no-session': 'Turn on background router access in settings to collect telemetry.',
      'telemetry-note.session-link': 'Open settings',
    }),
    telemetry: {
      fetchProjected: vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000)),
      ...overrides.telemetry,
    },
  });

  fixture.context.navigation.href = (): string => '/settings/general';

  const context = Object.assign(Object.create(fixture.context), {
    setTileTitle: overrides.setTileTitle ?? vi.fn(),
  }) as TestPluginContext;

  app = createApp(App, {ctx: context});
  app.mount(host);

  return fixture;
}

describe('App', () => {
  it('keeps stale chart data, retries immediately, and restarts the refresh interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 10, 15, 9, 42));

    let resolveRetry: ((value: ReturnType<typeof supportedSnapshot>) => void) | undefined;
    const retryRequest = new Promise<ReturnType<typeof supportedSnapshot>>((resolve) => {
      resolveRetry = resolve;
    });
    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockRejectedValueOnce(new Error('scheduled refresh failed'))
      .mockRejectedValueOnce(new Error('retry failed'))
      .mockImplementationOnce(() => retryRequest)
      .mockResolvedValue(supportedSnapshot(3000, 4000));

    mountApp({telemetry: {fetchProjected}});
    await flushPromises();

    vi.advanceTimersByTime(15 * 60_000);
    await flushPromises();

    const notice = host.querySelector<HTMLElement>('.app__stale');

    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('Not updated since 09:42');
    expect(host.querySelector('mndw-line-chart')).not.toBeNull();

    host.querySelector<HTMLElement>('.app__stale mndw-button')?.click();
    await flushPromises();

    expect(fetchProjected).toHaveBeenCalledTimes(3);
    expect(host.querySelector('.app__stale')?.textContent).toContain('Not updated since 09:42');

    const retryButton = host.querySelector<HTMLElement>('.app__stale mndw-button');

    retryButton?.click();
    await nextTick();

    expect(fetchProjected).toHaveBeenCalledTimes(4);
    expect(retryButton?.hasAttribute('disabled')).toBe(true);
    expect(retryButton?.getAttribute('aria-busy')).toBe('true');

    resolveRetry?.(supportedSnapshot(3000, 4000));
    await flushPromises();

    expect(host.querySelector('.app__stale')).toBeNull();
    expect(host.querySelector('mndw-line-chart')).not.toBeNull();

    vi.advanceTimersByTime(15 * 60_000 - 1);
    await flushPromises();
    expect(fetchProjected).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(fetchProjected).toHaveBeenCalledTimes(5);
  });

  it('offers Retry from the initial error view and recovers', async () => {
    vi.useFakeTimers();

    const fetchProjected = vi.fn()
      .mockRejectedValueOnce(new Error('initial load failed'))
      .mockResolvedValue(supportedSnapshot(1000, 2000));

    mountApp({telemetry: {fetchProjected}});
    await flushPromises();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Error');

    const retryButton = host.querySelector<HTMLElement>('[role="alert"] mndw-button');

    expect(retryButton).not.toBeNull();

    if (retryButton === null) {
      throw new Error('Retry button was not rendered');
    }

    expect(retryButton.textContent).toContain('Retry');
    retryButton.click();
    await nextTick();

    expect(fetchProjected).toHaveBeenCalledTimes(2);
    expect(retryButton.hasAttribute('disabled')).toBe(true);
    expect(retryButton.getAttribute('aria-busy')).toBe('true');

    await flushPromises();

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
  });

  it('includes the date when the last successful refresh was not today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 10, 15, 23, 40));

    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockRejectedValue(new Error('scheduled refresh failed'));

    mountApp({telemetry: {fetchProjected}});
    await flushPromises();

    vi.advanceTimersByTime(15 * 60_000);
    await flushPromises();

    expect(host.querySelector('.app__stale')?.textContent).toContain('23:40');
    expect(host.querySelector('.app__stale')?.textContent).not.toContain('2025');

    vi.setSystemTime(new Date(2025, 10, 16, 0, 5));
    vi.advanceTimersByTime(15 * 60_000);
    await flushPromises();

    const notice = host.querySelector('.app__stale');

    expect(notice?.textContent).toContain('2025');
    expect(notice?.textContent).toContain('23:40');
  });

  it('ignores an in-flight Retry after switching ranges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 10, 15, 9, 42));

    let resolveRetry: ((value: ReturnType<typeof supportedSnapshot>) => void) | undefined;
    const retryRequest = new Promise<ReturnType<typeof supportedSnapshot>>((resolve) => {
      resolveRetry = resolve;
    });
    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockRejectedValueOnce(new Error('scheduled refresh failed'))
      .mockImplementationOnce(() => retryRequest)
      .mockResolvedValueOnce(supportedSnapshot(3000, 4000));

    mountApp({telemetry: {fetchProjected}});
    await flushPromises();

    vi.advanceTimersByTime(15 * 60_000);
    await flushPromises();

    host.querySelector<HTMLElement>('.app__stale mndw-button')?.click();
    await nextTick();

    const retrySignal = fetchProjected.mock.calls[2]?.[1]?.signal;
    const segmented = host.querySelector<HTMLElement>('mndw-segmented');

    if (segmented === null) {
      throw new Error('range segmented control was not rendered');
    }

    segmented.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: '7d'}}));
    await flushPromises();

    expect(retrySignal?.aborted).toBe(true);
    expect(fetchProjected).toHaveBeenLastCalledWith('7d', expect.any(Object));

    resolveRetry?.(supportedSnapshot(9000, 10_000));
    await flushPromises();

    const chart = host.querySelector<HTMLElement & {domain?: {start: number; end: number}}>('mndw-line-chart');

    expect(chart?.domain).toEqual({start: 3000, end: 4000});
  });

  it('aborts an in-flight Retry when unmounted', async () => {
    vi.useFakeTimers();

    let resolveRetry: ((value: ReturnType<typeof supportedSnapshot>) => void) | undefined;
    const retryRequest = new Promise<ReturnType<typeof supportedSnapshot>>((resolve) => {
      resolveRetry = resolve;
    });
    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockRejectedValueOnce(new Error('scheduled refresh failed'))
      .mockImplementationOnce(() => retryRequest);

    mountApp({telemetry: {fetchProjected}});
    await flushPromises();

    vi.advanceTimersByTime(15 * 60_000);
    await flushPromises();

    host.querySelector<HTMLElement>('.app__stale mndw-button')?.click();
    await nextTick();

    const retrySignal = fetchProjected.mock.calls[2]?.[1]?.signal;

    app?.unmount();
    app = null;
    expect(retrySignal?.aborted).toBe(true);

    resolveRetry?.(supportedSnapshot(3000, 4000));
    await flushPromises();

    expect(host.querySelector('.app')).toBeNull();
  });

  it('calls fetchProjected with default range on mount', async () => {
    const fetchProjected = vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000));

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchProjected).toHaveBeenCalledWith('1d', expect.any(Object));
  });

  it('renders mndw-line-chart with domain prop after data loads', async () => {
    mountApp();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const chart = host.querySelector('mndw-line-chart') as
      | HTMLElement & {
        domain?: {start: number; end: number};
      }
      | null;

    if (chart === null) {
      throw new Error('line chart was not rendered');
    }

    expect(chart.domain).toEqual({start: 1000, end: 2000});
  });

  it('keeps chart layout bounded inside a dashboard tile', async () => {
    mountApp();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const appElement = host.querySelector<HTMLElement>('.app');
    const rangeScroll = host.querySelector<HTMLElement>('.range-scroll');
    const chartWrapper = host.querySelector<HTMLElement>('.chart-wrapper');
    const chart = host.querySelector<HTMLElement>('mndw-line-chart');

    if (appElement === null || rangeScroll === null || chartWrapper === null || chart === null) {
      throw new Error('chart layout was not rendered');
    }

    expect(getComputedStyle(appElement).height).toBe('100%');
    expect(getComputedStyle(appElement).minHeight).toBe('0');
    expect(getComputedStyle(rangeScroll).flexShrink).toBe('0');
    expect(getComputedStyle(rangeScroll).paddingBottom).toBe('4px');
    expect(getComputedStyle(chartWrapper).display).toBe('flex');
    expect(getComputedStyle(chartWrapper).flexGrow).toBe('1');
    expect(getComputedStyle(chartWrapper).minHeight).toBe('0');
    expect(getComputedStyle(chart).height).toBe('100%');
  });

  it('marks the default range selected and follows later range changes', async () => {
    mountApp();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-segment[value="1d"]')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('mndw-segment[value="7d"]')?.getAttribute('aria-checked')).toBe('false');

    const segmented = host.querySelector<HTMLElement>('mndw-segmented');

    if (segmented === null) {
      throw new Error('range segmented control was not rendered');
    }

    segmented.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: '7d'}}));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-segment[value="1d"]')?.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('mndw-segment[value="7d"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('switching range calls fetchProjected with the new range', async () => {
    const fetchProjected = vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000));

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const segmented = host.querySelector<HTMLElement>('mndw-segmented');

    if (segmented === null) {
      throw new Error('range segmented control was not rendered');
    }

    segmented.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: '7d'}}));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchProjected).toHaveBeenCalledWith('7d', expect.any(Object));
  });

  it('keeps the previous chart mounted and marks it busy while the new range loads', async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        })
      );

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const previousChart = host.querySelector('mndw-line-chart');

    const segmented = host.querySelector<HTMLElement>('mndw-segmented');

    if (segmented === null) {
      throw new Error('range segmented control was not rendered');
    }

    segmented.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: '7d'}}));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).toBe(previousChart);
    expect(host.querySelector('.chart-wrapper')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading…');
    expect(getComputedStyle(previousChart as HTMLElement).opacity).toBe('0.55');

    resolveSecond?.(supportedSnapshot(3000, 4000));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
  });

  it('shows unsupported state without rendering a chart', async () => {
    const fetchProjected = vi.fn().mockResolvedValue({
      keys: {
        temp: {
          supported: false,
          unit: 'celsius',
          points: [],
          segments: [],
          bands: [],
        },
      },
      gathering: {enabled: true},
    });

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).toBeNull();
    expect(host.querySelector('.app__message[role="status"]')?.textContent).toContain('Unsupported');
  });

  it.each([
    {replayPending: false, label: 'Historical'},
    {replayPending: true, label: 'Catching up…'},
  ])('renders the chart with a "$label" marker when history is not current', async ({replayPending, label}) => {
    const fetchProjected = vi.fn().mockResolvedValue({
      ...supportedSnapshot(1000, 2000),
      clock: {state: 'unanchored', historyEndMs: 2000, historyCurrent: false, replayPending},
    });

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
    expect(host.querySelector('[data-testid="history-status"]')?.textContent?.trim()).toBe(label);
  });

  it('shows no history marker when history is current', async () => {
    const fetchProjected = vi.fn().mockResolvedValue({
      ...supportedSnapshot(1000, 2000),
      clock: {state: 'anchored', historyEndMs: 2000, historyCurrent: true, replayPending: false},
    });

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
    expect(host.querySelector('[data-testid="history-status"]')).toBeNull();
  });

  it('keeps the chart visible when gathering is off and shows the formatted last point time', async () => {
    const end = new Date(2025, 10, 8, 9, 42).getTime();
    const fetchProjected = vi.fn().mockResolvedValue(
      supportedSnapshot(1000, end, {gatheringEnabled: false}),
    );

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
    expect(host.querySelector('.telemetry-note')?.textContent).toContain(
      'Telemetry collection is off. The chart shows data up to 08.11 09:42.',
    );
  });

  it('links the telemetry note to general settings through host navigation', async () => {
    const testContext = mountApp({
      telemetry: {fetchProjected: vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000, {gatheringEnabled: false}))},
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const link = host.querySelector<HTMLAnchorElement>('.telemetry-note a');

    expect(link?.getAttribute('href')).toBe('/settings/general');

    if (link === null) {
      throw new Error('Settings link was not rendered');
    }

    link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));

    expect(testContext.navigationCalls).toEqual([{kind: 'settings', tab: 'general'}]);
  });

  it('refetches the selected range and follows gathering stream changes immediately', async () => {
    const gathering = createGatheringStream();
    const fetchProjected = vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000));

    mountApp({telemetry: {fetchProjected, gathering$: gathering.gathering$}});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchProjected).toHaveBeenCalledTimes(1);

    gathering.emit(false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchProjected).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.telemetry-note')?.textContent).toContain('Telemetry collection is off.');

    gathering.emit(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchProjected).toHaveBeenCalledTimes(3);
    expect(host.querySelector('.telemetry-note')).toBeNull();
  });

  it('adds a Settings link to the existing long-range session requirement', async () => {
    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000, {sessionConfigured: false}));

    mountApp({telemetry: {fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const segmented = host.querySelector<HTMLElement>('mndw-segmented');

    if (segmented === null) {
      throw new Error('range segmented control was not rendered');
    }

    segmented.dispatchEvent(new CustomEvent('mndwchange', {detail: {value: '7d'}}));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('.telemetry-note')?.textContent).toContain(
      'Turn on background router access in settings to collect telemetry.',
    );
    expect(host.querySelector<HTMLAnchorElement>('.telemetry-note a')?.getAttribute('href')).toBe('/settings/general');
  });

  it('updates the host tile title after a locale switch and keeps history status in the body', async () => {
    const setTileTitle = vi.fn();
    const i18n = createTestI18n({title: 'CPU temperature'});

    mountApp({
      i18n,
      setTileTitle,
      telemetry: {
        fetchProjected: vi.fn().mockResolvedValue({
          ...supportedSnapshot(1000, 2000),
          clock: {state: 'unanchored', historyEndMs: 2000, historyCurrent: false, replayPending: false},
        }),
      },
    });
    await flushPromises();

    expect(setTileTitle).toHaveBeenLastCalledWith('CPU temperature');
    expect(host.querySelector('.app__header')).toBeNull();
    expect(host.querySelector('[data-testid="history-status"]')).not.toBeNull();

    i18n.setLocale('ru', {title: 'Температура CPU'});
    await nextTick();

    expect(setTileTitle).toHaveBeenLastCalledWith('Температура CPU');
  });
});
