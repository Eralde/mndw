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
  it('binds untimed history as points with metric presentation labels', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(LoadBarChart, {
      label: 'CPU',
      value: 20,
      history: [10, 20],
      translator: createTestI18n({'no-data': 'No data'}),
    });
    app.mount(host);
    await nextTick();

    const chart = host.querySelector<MndwSparkline>('mndw-sparkline');

    if (chart === null) {
      throw new Error('sparkline was not rendered');
    }

    await chart.updateComplete;

    expect(chart.points).toEqual<MndwChartSample[]>([
      {value: 10},
      {value: 20},
    ]);
    expect(chart.getAttribute('value-label')).toBe('CPU');
    expect(chart.getAttribute('aria-label')).toBe('CPU');
  });
});
