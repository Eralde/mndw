// @vitest-environment happy-dom
import {flushSync, mount, unmount} from 'svelte';
import {afterEach, describe, expect, it} from 'vitest';
import FullLayout from './FullLayout.svelte';
import LineLayout from './LineLayout.svelte';
import MediumLayout from './MediumLayout.svelte';
import type {LayoutLabels, RunView} from '../model/run-view.js';

const run: Readonly<RunView> = {
  phase: null,
  phaseLabel: 'Ready',
  currentValue: '0 Mbit/s',
  speed: 0,
  results: {
    download: '—',
    upload: '—',
    ping: '—',
    jitter: '—',
    summary: '↓ —  ↑ —  Ping —',
  },
  pingSamples: Array.from({length: 10}, () => null),
  pingPoints: [],
  pingDomain: {min: 0, max: 100},
  downloadSeries: [],
  uploadSeries: [],
  running: false,
  statusText: '',
};

const labels: Readonly<LayoutLabels> = {
  start: 'Start',
  stop: 'Stop',
  download: 'Download',
  upload: 'Upload',
  ping: 'Ping',
  jitter: 'Jitter',
  chartEmpty: 'No data',
  chartSeconds: 's',
  chartSpeed: 'Speed',
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('iperf layouts', () => {
  it('renders full tier gauge, action, chart, and results in order', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(FullLayout, {
      target,
      props: {
        run,
        labels,
        locale: 'en',
        pingPhaseLabel: 'Ping',
        formatPing: (value) => `${value} ms`,
        onStart: () => {},
        onStop: () => {},
      },
    });

    cleanups.push(async () => {
      await unmount(app);

      target.remove();
    });

    flushSync();

    const gauge = target.querySelector('.gauge-box');
    const action = target.querySelector('.action-zone');
    const chart = target.querySelector('.chart-box');
    const results = target.querySelector('.results-row');

    expect(gauge?.nextElementSibling).toBe(action);
    expect(action?.nextElementSibling).toBe(chart);
    expect(chart?.nextElementSibling).toBe(results);
  });

  it('keeps medium gauge and controls in one row with results below', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(MediumLayout, {
      target,
      props: {
        run,
        labels,
        locale: 'en',
        pingPhaseLabel: 'Ping',
        formatPing: (value) => `${value} ms`,
        onStart: () => {},
        onStop: () => {},
      },
    });

    cleanups.push(async () => {
      await unmount(app);

      target.remove();
    });

    flushSync();

    const row = target.querySelector('[data-testid="medium-row"]');
    const gauge = target.querySelector('.gauge-box');
    const actions = target.querySelector('.action-zone');
    const results = target.querySelector('.results-row');

    expect(gauge?.parentElement).toBe(row);
    expect(actions?.parentElement).toBe(row);
    expect(row?.nextElementSibling).toBe(results);
  });

  it('places compact line results before the trailing action', () => {
    const target = document.createElement('div');

    document.body.append(target);

    const app = mount(LineLayout, {
      target,
      props: {run, labels, resultsInline: true, onStart: () => {}, onStop: () => {}},
    });

    cleanups.push(async () => {
      await unmount(app);

      target.remove();
    });

    flushSync();

    const row = target.querySelector('.line-main');
    const results = target.querySelector('.line-main > .line-results');
    const action = target.querySelector<HTMLElement>('.line-action');

    expect(results?.nextElementSibling).toBe(action);
    expect(row?.lastElementChild).toBe(action);
    expect(action?.style.marginInlineStart).toBe('auto');
  });
});
