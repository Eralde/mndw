import {type MndwChartPoint, formatSpeed, getSpeedUpperLimit} from '@mndw/ui';

const START_TIME = 1_730_000_000_000;
const MINUTE = 60_000;

export function mount(root: HTMLElement): void {
  const chart = document.createElement('mndw-bar-chart');
  const values = [4200, 5500, 4900, 7200, 6600, 8100, 7400, 9200, 8600, 10400, 9600];
  const points: MndwChartPoint[] = values.map((value, index) => ({
    time: START_TIME + index * MINUTE,
    value,
  }));

  chart.setAttribute('value-label', 'Traffic per minute');
  chart.setAttribute('aria-label', 'Traffic per minute over ten minutes');
  chart.style.width = '100%';
  chart.valueFormatter = formatSpeed;
  chart.valueDomain = {min: 0, max: getSpeedUpperLimit(Math.max(...values))};
  chart.points = points;
  root.appendChild(chart);
}
