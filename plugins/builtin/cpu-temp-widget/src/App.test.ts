// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type App as VueApp, createApp} from 'vue';
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
});

function mountApp(overrides: {telemetry?: Partial<PluginTelemetry>} = {}): TestPluginContext {
  host = document.createElement('div');
  host.style.height = '190px';

  document.body.append(host);

  fixture = createTestPluginContext({
    i18n: createTestI18n({
      'title': 'CPU Temperature',
      'l10n.probe': 'l10n-ok',
      'loading': 'Loading…',
      'empty': 'Gathering data…',
      'error': 'Error',
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
      'telemetry-note.link': 'Turn it on in Settings',
      'telemetry-note.no-session': 'Set up a persistent RCI session to collect telemetry.',
      'telemetry-note.session-link': 'Open Settings',
    }),
    telemetry: {
      fetchProjected: vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000)),
      ...overrides.telemetry,
    },
  });

  fixture.context.navigation.href = (): string => '/settings/general';

  app = createApp(App, {ctx: fixture.context});
  app.mount(host);

  return fixture;
}

describe('App', () => {
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
    expect(host.textContent).toContain('Unsupported');
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
      'Set up a persistent RCI session to collect telemetry.',
    );
    expect(host.querySelector<HTMLAnchorElement>('.telemetry-note a')?.getAttribute('href')).toBe('/settings/general');
  });

  it('renders l10n probe span', () => {
    mountApp();

    expect(host.querySelector('[data-testid="l10n-probe"]')).not.toBeNull();
  });
});
