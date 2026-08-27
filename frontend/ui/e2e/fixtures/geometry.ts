import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import {MndwTable, column, defineMndwUi} from '../../src/index';

interface GeometryRow {
  id: string;
  name: string;
  description: string;
}

declare global {
  interface Window {
    __geometryTable: MndwTable<GeometryRow>;
    __geometryRows: GeometryRow[];
  }
}

defineMndwUi();

const table = document.querySelector<MndwTable<GeometryRow>>('#geometry-table');

if (table === null) {
  throw new Error('geometry table missing');
}

const rows = Array.from({length: 1000}, (_value, index) => ({
  id: `row-${index}`,
  name: `Package ${index}`,
  description: index % 7 === 0
    ? `Variable description ${index} `.repeat(8)
    : `Short description ${index}`,
}));

table.columns = [
  column<GeometryRow>()({id: 'name', label: 'Name', accessor: (row) => row.name}),
  column<GeometryRow>()({id: 'description', label: 'Description', accessor: (row) => row.description}),
];
table.rows = rows;
table.rowKey = 'id';
table.virtual = true;
table.estimatedRowHeight = 42;
table.overscan = 120;

window.__geometryTable = table;
window.__geometryRows = rows;

await table.updateComplete;
document.documentElement.dataset.ready = 'true';
