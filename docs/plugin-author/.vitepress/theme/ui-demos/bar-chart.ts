import type {MndwChartPoint} from '@mndw/ui';

// Value imports from @mndw/ui are dynamic: a static one would evaluate the custom elements during the
// docs SSR build, where HTMLElement does not exist. The theme has already loaded @mndw/ui by now.

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
  void import('@mndw/ui').then(({formatSpeed, getSpeedUpperLimit}) => {
    chart.valueFormatter = formatSpeed;
    chart.valueDomain = {min: 0, max: getSpeedUpperLimit(Math.max(...values))};
    chart.tooltipFormatter = ({samples}) => ({
      title: 'Traffic sample',
      rows: [{label: 'Rate', value: formatSpeed(samples[0]?.value ?? 0)}],
    });
    chart.points = points;
    root.appendChild(chart);
  });
}
