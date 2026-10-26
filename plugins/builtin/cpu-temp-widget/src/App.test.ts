// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type App as VueApp, createApp} from 'vue';
import {createTestI18n} from '@mndw/sdk/testing';
import App from './App.vue';

let host: HTMLElement;
let app: VueApp | null = null;

const supportedSnapshot = (start: number, end: number) => {
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
    gathering: {enabled: true},
    sessionConfigured: true,
  };
};

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

function mountApp(overrides: Record<string, unknown> = {}): void {
  host = document.createElement('div');
  host.style.height = '190px';

  document.body.append(host);

  const ctx = {
    i18n: createTestI18n({
      'title': 'CPU Temperature',
      'l10n.probe': 'l10n-ok',
      'loading': 'Loading…',
      'empty': 'Gathering data…',
      'error': 'Error',
      'disabled': 'Disabled',
      'unsupported': 'Unsupported',
      'range-1h': '1H',
      'range-3h': '3H',
      'range-1d': '1D',
      'range-7d': '7D',
      'range-30d': '30D',
      'history-catching-up': 'Catching up…',
      'history-historical': 'Historical',
    }),
    telemetry: {
      fetchAll: vi.fn(),
      fetchProjected: vi.fn().mockResolvedValue(supportedSnapshot(1000, 2000)),
    },
    storage: {get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined)},
    ...overrides,
  };

  app = createApp(App, {ctx});
  app.mount(host);
}

describe('App', () => {
  it('calls fetchProjected with default range on mount', async () => {
    mountApp();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ctx = (app as any)._instance?.props?.ctx;

    expect(ctx.telemetry.fetchProjected).toHaveBeenCalledWith('1d', expect.any(Object));
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
    const chartWrapper = host.querySelector<HTMLElement>('.chart-wrapper');

    if (appElement === null || chartWrapper === null) {
      throw new Error('chart layout was not rendered');
    }

    expect(getComputedStyle(appElement).height).toBe('100%');
    expect(getComputedStyle(appElement).minHeight).toBe('0');
    expect(getComputedStyle(chartWrapper).flexGrow).toBe('1');
    expect(getComputedStyle(chartWrapper).minHeight).toBe('0');
  });

  it('switching range calls fetchProjected with the new range', async () => {
    mountApp();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const btn7d = Array.from(host.querySelectorAll<HTMLButtonElement>('.range-controls button'))
      .find((button) => button.textContent?.trim() === '7D');

    if (btn7d === undefined) {
      throw new Error('7D range button was not rendered');
    }

    btn7d.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ctx = (app as any)._instance?.props?.ctx;

    expect(ctx.telemetry.fetchProjected).toHaveBeenCalledWith('7d', expect.any(Object));
  });

  it('does not render the previous range while the new range is loading', async () => {
    let resolveSecond: ((value: unknown) => void) | undefined;
    const fetchProjected = vi.fn()
      .mockResolvedValueOnce(supportedSnapshot(1000, 2000))
      .mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        })
      );

    mountApp({telemetry: {fetchAll: vi.fn(), fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    const btn7d = Array.from(host.querySelectorAll<HTMLButtonElement>('.range-controls button'))
      .find((button) => button.textContent?.trim() === '7D');

    if (btn7d === undefined) {
      throw new Error('7D range button was not rendered');
    }

    btn7d.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).toBeNull();
    expect(host.textContent).toContain('Loading…');

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

    mountApp({telemetry: {fetchAll: vi.fn(), fetchProjected}});
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

    mountApp({telemetry: {fetchAll: vi.fn(), fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
    expect(host.querySelector('[data-testid="history-status"]')?.textContent?.trim()).toBe(label);
  });

  it('shows no history marker when history is current', async () => {
    const fetchProjected = vi.fn().mockResolvedValue({
      ...supportedSnapshot(1000, 2000),
      clock: {state: 'anchored', historyEndMs: 2000, historyCurrent: true, replayPending: false},
    });

    mountApp({telemetry: {fetchAll: vi.fn(), fetchProjected}});
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host.querySelector('mndw-line-chart')).not.toBeNull();
    expect(host.querySelector('[data-testid="history-status"]')).toBeNull();
  });

  it('renders l10n probe span', () => {
    mountApp();

    expect(host.querySelector('[data-testid="l10n-probe"]')).not.toBeNull();
  });
});
