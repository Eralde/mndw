import type {MndwChartSample} from '@mndw/ui';

const START_TIME = 1_730_000_000_000;
const MINUTE = 60_000;

export function mount(root: HTMLElement): void {
  const chart = document.createElement('mndw-sparkline');
  const values = [31, 34, 29, 38, 43, 40, 52, 48, 57, 54, 63, 59, 68, 61, 72];
  const points: MndwChartSample[] = values.map((value, index) => ({
    time: START_TIME + index * MINUTE,
    value,
  }));

  chart.setAttribute('value-label', 'CPU load');
  chart.setAttribute('aria-label', 'CPU load history');
  chart.style.width = '100%';
  chart.max = 100;
  chart.points = points;
  root.appendChild(chart);
}
