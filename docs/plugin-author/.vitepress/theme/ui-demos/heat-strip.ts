import type {MndwChartSample} from '@mndw/ui';

const START_TIME = 1_730_000_000_000;
const MINUTE = 60_000;

export function mount(root: HTMLElement): void {
  const chart = document.createElement('mndw-heat-strip');
  const values = [14, 18, 22, 35, 48, 55, 62, 79, 88, 73, 67, 52, 44, 38, 25, 19, 31, 46, 58, 71];
  const points: MndwChartSample[] = values.map((value, index) => ({
    time: START_TIME + index * MINUTE,
    value,
  }));

  chart.setAttribute('value-label', 'Radio utilization');
  chart.setAttribute('aria-label', 'Radio utilization history');
  chart.style.width = '100%';
  chart.max = 100;
  chart.points = points;
  root.appendChild(chart);
}
