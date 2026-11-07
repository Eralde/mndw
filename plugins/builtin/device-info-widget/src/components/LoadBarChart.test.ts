// @vitest-environment happy-dom
import {createTestI18n} from '@mndw/sdk/testing';
import type {MndwChartSample, MndwSparkline} from '@mndw/ui';
import {type App as VueApp, createApp, nextTick} from 'vue';
import {afterEach, describe, expect, it} from 'vitest';
import LoadBarChart from './LoadBarChart.vue';

let host: HTMLElement | undefined;
let app: VueApp | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

describe('LoadBarChart', () => {
  it('binds timed and untimed history samples with metric presentation labels', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(LoadBarChart, {
      label: 'CPU',
      value: 20,
      history: [{value: 10}, {time: 2_000, value: 20}],
      timeDomain: {start: 1_000, end: 3_000},
      translator: createTestI18n({'no-data': 'No data'}),
    });
    app.mount(host);
    await nextTick();

    const chart = host.querySelector<MndwSparkline>('mndw-sparkline');

    if (chart === null) {
      throw new Error('sparkline was not rendered');
    }

    await chart.updateComplete;

    expect(chart.points).toEqual<MndwChartSample[]>([{value: 10}, {time: 2_000, value: 20}]);
    expect(chart.timeDomain).toEqual({start: 1_000, end: 3_000});
    expect(chart.getAttribute('value-label')).toBe('CPU');
    expect(chart.getAttribute('aria-label')).toBe('CPU');

    const chartContainer = host.querySelector<HTMLElement>('.load-bar-chart__chart');

    if (chartContainer === null) {
      throw new Error('chart container was not rendered');
    }

    expect(getComputedStyle(chartContainer).height).toBe('40px');
  });

  it('uses date labels for a multi-day time domain', async () => {
    host = document.createElement('div');
    document.body.append(host);

    const translator = createTestI18n({'no-data': 'No data'});
    const start = Date.parse('2026-08-28T13:00:00');
    const end = Date.parse('2026-09-04T12:54:00');

    app = createApp(LoadBarChart, {
      label: 'CPU',
      value: 20,
      history: [{time: start, value: 10}, {time: end, value: 20}],
      timeDomain: {start, end},
      translator,
    });
    app.mount(host);
    await nextTick();

    const chart = host.querySelector<MndwSparkline>('mndw-sparkline');

    if (chart === null) {
      throw new Error('sparkline was not rendered');
    }

    await chart.updateComplete;

    const labels = [...(chart.shadowRoot?.querySelectorAll('.axis span') ?? [])]
      .map((span) => span.textContent);
    const options = {month: 'short' as const, day: 'numeric' as const};

    expect(labels).toEqual([
      translator.formatDate(new Date(start), options),
      translator.formatDate(new Date(end), options),
    ]);
  });

  it('keeps the sparkline mounted and announces loading without changing chart height', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(LoadBarChart, {
      label: 'CPU',
      value: 20,
      history: [{value: 10}],
      loading: true,
      translator: createTestI18n({'loading': 'Loading…', 'no-data': 'No data'}),
    });
    app.mount(host);
    await nextTick();

    const chart = host.querySelector<MndwSparkline>('mndw-sparkline');
    const chartContainer = host.querySelector<HTMLElement>('.load-bar-chart__chart');

    expect(host.querySelector('.load-bar-chart__value')?.textContent).toBe('20%');
    expect(host.querySelector('[data-testid="history-loading"]')?.textContent).toBe('Loading…');
    expect(chart?.points).toEqual<MndwChartSample[]>([{value: 10}]);
    expect(chartContainer?.getAttribute('aria-busy')).toBe('true');
    expect(chartContainer === null ? '' : getComputedStyle(chartContainer).height).toBe('40px');
    expect(chart === null ? '' : getComputedStyle(chart).opacity).toBe('0.55');
  });
});
