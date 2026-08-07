import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import {type MndwChartPoint, type MndwChartSeries, defineMndwUi} from '../../src/index';

defineMndwUi();

const form = document.querySelector<HTMLFormElement>('#component-form');

if (!form) {
  throw new Error('component form missing');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  document.documentElement.dataset.submitted = 'true';
  document.documentElement.dataset.formData = JSON.stringify([...new FormData(form).entries()]);
});

const lineChart = document.querySelector<HTMLElement & {
  series: readonly MndwChartSeries[];
  domain: {start: number; end: number};
  updateComplete: Promise<unknown>;
}>('#line-chart-fixture-element');
const barChart = document.querySelector<HTMLElement & {
  points: readonly MndwChartPoint[];
  updateComplete: Promise<unknown>;
}>('#bar-chart-fixture-element');

if (!lineChart || !barChart) {
  throw new Error('chart fixtures missing');
}

lineChart.series = [
  {
    id: 'upload',
    label: 'Upload',
    color: 'accent',
    fill: true,
    data: [
      {time: 1_700_000_000_000, value: 100},
      {time: 1_700_000_060_000, value: 200},
    ],
  },
  {
    id: 'download',
    label: 'Download',
    color: 'success',
    data: [
      {time: 1_700_000_000_000, value: 50},
      {time: 1_700_000_060_000, value: 150},
    ],
  },
];
lineChart.domain = {start: 1_700_000_000_000, end: 1_700_000_060_000};
barChart.points = [
  {time: 1_700_000_000_000, value: 100},
  {time: 1_700_000_030_000, value: 200},
  {time: 1_700_000_060_000, value: 150},
];

await Promise.all([lineChart.updateComplete, barChart.updateComplete]);
document.documentElement.dataset.ready = 'true';
