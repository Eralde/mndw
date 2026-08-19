import '@angular/compiler';
import {CUSTOM_ELEMENTS_SCHEMA, Component, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {type Column, type SortState, column} from '@mndw/ui';
import {MndwCellDirective, MndwTableDirective} from '@mndw/ui-angular';
import type {MwsNode} from '../../domain/mws/mws.types';
import {type NodeRow, buildNodeRows} from './node-rows';

function node(id: string, name: string, ip: string | null = null, clients: number = 0): MwsNode {
  return {
    id,
    cid: null,
    name,
    model: null,
    ip,
    mac: id,
    isController: id === 'node-a',
    isOnline: true,
    fw: '5.2',
    fwAvailable: null,
    system: {cpuload: null, memoryUsed: null, memoryTotal: null, uptime: 120},
    backhaul: {
      uplink: null,
      bridge: null,
      ap: null,
      rssi: -52,
      txrate: 866,
      mode: '11ax',
      security: null,
      cost: null,
      speed: null,
      duplex: null,
      portLabel: null,
    },
    parent: null,
    children: [],
    clients: Array.from({length: clients}, (_value, index) => ({id: `c-${index}`})),
    dualBand: true,
  };
}

function columns(): Column<unknown>[] {
  return [
    column<NodeRow>()({id: 'name', label: 'Node name', accessor: (row) => row.node.name, sortable: true}),
    column<NodeRow>()({id: 'ip', label: 'IP', accessor: (row) => row.node.ip, sortable: true}),
    column<NodeRow>()({id: 'clients', label: 'Clients', accessor: (row) => row.node.clients.length, kind: 'number',
      sortable: true}),
  ] as Column<unknown>[];
}

@Component({
  selector: 'contract-host',
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <mndw-table
      [columns]="columns"
      [rows]="rows()"
      rowKey="id"
      [sort]="sort"
      [hiddenColumns]="hiddenColumns"
      [columnMenu]="false"
      (mndwsortchange)="onSort($event)"
    >
      <ng-template mndwCell="name" [mndwCellRows]="rows" let-row>
        <button class="node-name" (click)="activate(row.id)">{{ row.node.name }}</button>
      </ng-template>
    </mndw-table>
  `,
})
class ContractHost {
  public columns = columns();
  public rows = signal<readonly NodeRow[]>([]);
  public sort: SortState | null = null;
  public hiddenColumns: string[] = [];
  public activated: string[] = [];

  public activate(id: string): void {
    this.activated.push(id);
  }

  public onSort(event: CustomEvent<{sort: SortState | null}>): void {
    this.sort = event.detail.sort;
  }
}

function render(
  rows: NodeRow[],
): {fixture: ReturnType<typeof TestBed.createComponent<ContractHost>>; table: HTMLElement} {
  const fixture = TestBed.createComponent(ContractHost);

  fixture.componentInstance.rows.set(rows);
  fixture.detectChanges();

  const native = fixture.nativeElement as HTMLElement;
  const table = native.querySelector('mndw-table') as HTMLElement;

  return {fixture, table};
}

async function settled(table: HTMLElement): Promise<void> {
  await Promise.resolve();
  await (table as unknown as {updateComplete: Promise<unknown>}).updateComplete;
}

describe('nodes-table table contract', () => {
  it('renders shadow columns and the light-DOM name cell through the shared table', async () => {
    const {table} = render(buildNodeRows([node('node-a', 'Node A', '10.0.0.2', 3)]));

    await settled(table);

    const shadow = (table as unknown as {shadowRoot: ShadowRoot}).shadowRoot;

    expect(shadow.querySelectorAll('thead th').length).toBe(3);
    expect(shadow.querySelector('tbody')?.textContent).toContain('10.0.0.2');
    expect(shadow.querySelector('tbody')?.textContent).toContain('3');

    const nameCell = table.querySelector('.node-name');

    expect(nameCell?.textContent).toBe('Node A');
  });

  it('writes controlled sort back and reorders rows', async () => {
    const {fixture, table} = render(
      buildNodeRows([node('node-a', 'B Node', '10.0.0.2'), node('node-b', 'A Node', '10.0.0.1')]),
    );

    await settled(table);

    const shadow = (table as unknown as {shadowRoot: ShadowRoot}).shadowRoot;
    const button = shadow.querySelector<HTMLButtonElement>('button[data-sort-column="name"]');

    button?.click();
    fixture.detectChanges();
    await settled(table);

    expect(fixture.componentInstance.sort).toEqual({columnId: 'name', direction: 'asc'});
    expect(shadow.querySelector('th[aria-sort="ascending"]')).not.toBeNull();
    expect(shadow.querySelector('tbody tr:first-child')?.textContent).toContain('10.0.0.1');
  });

  it('updates a cell in place when a same-key row is replaced', async () => {
    const {fixture, table} = render(buildNodeRows([node('node-a', 'Node A')]));

    await settled(table);

    fixture.componentInstance.rows.set(buildNodeRows([node('node-a', 'Node A2')]));
    fixture.detectChanges();
    await settled(table);

    const nameCell = table.querySelector('.node-name');

    expect(nameCell?.textContent).toBe('Node A2');
    expect(table.querySelectorAll('[slot]').length).toBe(1);
  });
});
