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
  };
};

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
});

function mountApp(overrides: Record<string, unknown> = {}): void {
  host = document.createElement('div');

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

  it('renders l10n probe span', () => {
    mountApp();

    expect(host.querySelector('[data-testid="l10n-probe"]')).not.toBeNull();
  });
});
