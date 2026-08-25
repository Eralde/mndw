import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import {
  type CellRenderer,
  type Column,
  type MndwChartPoint,
  type MndwChartSeries,
  type MndwColumnVisibilityChangeDetail,
  type MndwRowReorderDetail,
  type MndwSelectionChangeDetail,
  type MndwSortChangeDetail,
  type MndwTable,
  defineMndwUi,
} from '../../src/index';

declare global {
  interface Window {
    __fixtureReorderIntents: MndwRowReorderDetail[];
  }
}

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

interface FixtureDeviceRow {
  id: string;
  device: {name: string; model: string};
  status: 'online' | 'offline';
  value: number;
  note: string;
}

const fixtureRows: FixtureDeviceRow[] = [
  {id: 'dev-1', device: {name: 'Alpha', model: 'AX-100'}, status: 'online', value: 500, note: 'Primary'},
  {id: 'dev-2', device: {name: 'Beta', model: 'BX-200'}, status: 'offline', value: 120, note: 'Spare'},
  {id: 'dev-3', device: {name: 'Gamma', model: 'GX-300'}, status: 'online', value: 340, note: 'Backup'},
  {id: 'dev-4', device: {name: 'Delta', model: 'DX-400'}, status: 'offline', value: 0, note: 'Retired'},
  {id: 'dev-5', device: {name: 'Epsilon', model: 'EX-500'}, status: 'online', value: 780, note: 'Lab'},
];

const fixtureLinkCell: CellRenderer<FixtureDeviceRow> = {
  mount(context) {
    const link = document.createElement('a');

    link.className = 'fixture-link';
    link.href = '#';
    link.textContent = 'Open';
    context.node.appendChild(link);
  },
  update() {},
  destroy() {},
};

const fixtureColumns: Column<FixtureDeviceRow>[] = [
  {id: 'name', label: 'Device', sortable: true, hideable: false, accessor: (row) => row.device.name},
  {id: 'model', label: 'Model', sortable: true, accessor: (row) => row.device.model},
  {
    id: 'status',
    label: 'Status',
    sortable: true,
    accessor: (row) => row.status,
    kind: 'badge',
    badge: (value, row) => ({text: value as string, tone: row.status === 'online' ? 'success' : 'danger'}),
  },
  {id: 'value', label: 'Throughput', sortable: true, kind: 'number', align: 'end', accessor: (row) => row.value},
  {id: 'link', label: 'Link', sortable: false, renderer: () => fixtureLinkCell},
  {id: 'note', label: 'Note', sortable: false, accessor: (row) => row.note},
  {id: 'detail', label: 'Detail', sortable: false, accessor: (row) => `${row.device.model}/${row.status}`},
];

const table = document.querySelector<MndwTable<FixtureDeviceRow>>('#table-fixture');

if (!table) {
  throw new Error('table fixture missing');
}

window.__fixtureReorderIntents = [];

table.addEventListener('mndwsortchange', (event) => {
  table.sort = (event as CustomEvent<MndwSortChangeDetail>).detail.sort;
});
table.addEventListener('mndwselectionchange', (event) => {
  table.selected = (event as CustomEvent<MndwSelectionChangeDetail>).detail.selected;
});
table.addEventListener('mndwcolumnvisibilitychange', (event) => {
  table.hiddenColumns = (event as CustomEvent<MndwColumnVisibilityChangeDetail>).detail.hidden;
});
table.addEventListener('mndwrowreorder', (event) => {
  window.__fixtureReorderIntents.push((event as CustomEvent<MndwRowReorderDetail>).detail);
});

table.columns = fixtureColumns;
table.rows = fixtureRows;
table.rowKey = 'id';
table.selectable = true;
table.reorderable = true;
table.sort = {columnId: 'name', direction: 'asc'};

const stickyTable = document.querySelector<MndwTable<FixtureDeviceRow>>('#table-sticky-fixture');

if (stickyTable !== null) {
  stickyTable.rowKey = 'id';
  stickyTable.columnMenu = false;
  stickyTable.columns = [
    {...fixtureColumns[0], sticky: 'start', width: '200px'},
    {...fixtureColumns[1], width: '200px', nowrap: true},
    ...fixtureColumns.slice(2).map((column) => ({...column, width: '200px'})),
  ];
  stickyTable.rows = Array.from({length: 40}, (_value, index) => {
    const base = fixtureRows[index % fixtureRows.length];

    return {...base, id: `${base.id}-${index}`};
  });
}

await Promise.all([
  lineChart.updateComplete,
  barChart.updateComplete,
  table.updateComplete,
  ...(stickyTable === null ? [] : [stickyTable.updateComplete]),
]);
document.documentElement.dataset.ready = 'true';
