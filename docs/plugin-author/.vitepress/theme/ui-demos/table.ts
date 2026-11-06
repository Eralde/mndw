import {type Column, type MndwSortChangeDetail} from '@mndw/ui';

interface ClientRow {
  id: string;
  name: string;
  ip: string;
  mac: string;
  traffic: number;
}

const columns: Column<ClientRow>[] = [
  {id: 'name', label: 'Name', accessor: 'name', sortable: true, hideable: false},
  {id: 'ip', label: 'IP address', accessor: 'ip'},
  {id: 'mac', label: 'MAC address', accessor: 'mac'},
  {id: 'traffic', label: 'Traffic (MB)', accessor: 'traffic', kind: 'number', align: 'end', sortable: true},
];

const rows: ClientRow[] = [
  {id: 'client-01', name: 'Studio laptop', ip: '192.168.1.24', mac: '24:6F:28:10:4A:01', traffic: 842.6},
  {id: 'client-02', name: 'Living room TV', ip: '192.168.1.31', mac: '24:6F:28:10:4A:02', traffic: 625.3},
  {id: 'client-03', name: 'Workstation', ip: '192.168.1.42', mac: '24:6F:28:10:4A:03', traffic: 412.8},
  {id: 'client-04', name: 'Tablet', ip: '192.168.1.58', mac: '24:6F:28:10:4A:04', traffic: 206.4},
  {id: 'client-05', name: 'Game console', ip: '192.168.1.77', mac: '24:6F:28:10:4A:05', traffic: 178.9},
  {id: 'client-06', name: 'Network printer', ip: '192.168.1.90', mac: '24:6F:28:10:4A:06', traffic: 12.1},
];

function mountTable(root: HTMLElement, demo: 'sorting' | 'visibility'): void {
  const table = document.createElement('mndw-table');

  table.dataset.demo = demo;
  table.style.width = '100%';
  table.caption = 'Connected clients and recent traffic';
  table.layout = 'auto';
  table.rowKey = 'id';
  table.columns = columns;
  table.rows = rows;
  table.sort = {columnId: 'traffic', direction: 'desc'};
  table.addEventListener('mndwsortchange', (event: Event): void => {
    table.sort = (event as CustomEvent<MndwSortChangeDetail>).detail.sort;
  });

  root.appendChild(table);
}

export function mountSorting(root: HTMLElement): void {
  mountTable(root, 'sorting');
}

export function mountVisibility(root: HTMLElement): void {
  mountTable(root, 'visibility');
}
