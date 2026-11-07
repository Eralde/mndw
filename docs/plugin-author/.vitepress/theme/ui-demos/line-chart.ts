import type {MndwChartSeries} from '@mndw/ui';

// Value imports from @mndw/ui are dynamic: a static one would evaluate the custom elements during the
// docs SSR build, where HTMLElement does not exist. The theme has already loaded @mndw/ui by now.

const START_TIME = 1_730_000_000_000;
const MINUTE = 60_000;

export function mount(root: HTMLElement): void {
  const chart = document.createElement('mndw-line-chart');
  const rxValues = [1800, 2200, 2000, 3400, 2800, 4200, 3800, 5500, 4800, 6200, 5800];
  const txValues = [800, 1200, 1000, 1700, 1500, 2100, 1900, 2500, 2200, 3100, 2700];
  const toPoints = (values: readonly number[]): {time: number; value: number}[] => {
    return values.map((value, index) => ({time: START_TIME + index * MINUTE, value}));
  };
  const series: MndwChartSeries[] = [
    {id: 'rx', label: 'RX', color: 'accent', fill: true, data: toPoints(rxValues)},
    {id: 'tx', label: 'TX', color: 'success', data: toPoints(txValues)},
  ];

  chart.setAttribute('aria-label', 'Receive and transmit throughput over ten minutes');
  chart.style.width = '100%';
  void import('@mndw/ui').then(({formatSpeed, getSpeedUpperLimit}) => {
    chart.valueFormatter = formatSpeed;
    chart.valueDomain = {min: 0, max: getSpeedUpperLimit(Math.max(...rxValues, ...txValues))};
    chart.series = series;
    chart.domain = {start: START_TIME, end: START_TIME + 10 * MINUTE};
    root.appendChild(chart);
  });
}
