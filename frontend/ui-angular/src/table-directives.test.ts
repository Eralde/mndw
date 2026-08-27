import {CUSTOM_ELEMENTS_SCHEMA, Component, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {type Column, column} from '@mndw/ui';
import {MndwCellDirective, MndwTableDirective} from './table-directives.js';

interface TestRow {
  id: string;
  name: string;
}

@Component({
  selector: 'directive-host',
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <mndw-table [columns]="columns" [rows]="rows()" rowKey="id" [columnMenu]="false">
      <ng-template mndwCell="name" [mndwCellRows]="rows" let-row let-value="value" let-colId="colId">
        <span class="custom-name">{{ row.name }}/{{ value }}/{{ colId }}</span>
      </ng-template>
    </mndw-table>
  `,
})
class DirectiveHost {
  public columns = [column<TestRow>()({id: 'name', label: 'Name', accessor: (row) => row.name})] as Column<unknown>[];
  public rows = signal<readonly TestRow[]>([{id: 'a', name: 'A'}]);
}

async function createHost(): Promise<
  {fixture: ReturnType<typeof TestBed.createComponent<DirectiveHost>>; table: HTMLElement}
> {
  const fixture = TestBed.createComponent(DirectiveHost);

  fixture.detectChanges();

  const native = fixture.nativeElement as HTMLElement;
  const table = native.querySelector('mndw-table') as HTMLElement;

  await (table as unknown as {updateComplete: Promise<unknown>}).updateComplete;

  return {fixture, table};
}

describe('mndw-table directives', () => {
  it('merges a template renderer into the native table columns', async () => {
    const {table} = await createHost();

    const columns = (table as unknown as {columns: Column<unknown>[]}).columns;

    expect(columns[0].renderer).toBeDefined();
  });

  it('stamps the template into a parked node with the full context', async () => {
    const {table} = await createHost();

    const parked = table.querySelector('[slot]');

    expect(parked?.textContent).toBe('A/A/name');
  });

  it('updates the view in place without remounting on same-key replacement', async () => {
    const {fixture, table} = await createHost();

    fixture.componentInstance.rows.set([{id: 'a', name: 'A2'}]);
    fixture.detectChanges();

    await (table as unknown as {updateComplete: Promise<unknown>}).updateComplete;

    const parked = table.querySelector('[slot]');

    expect(parked?.textContent).toBe('A2/A2/name');
    expect(table.querySelectorAll('[slot]').length).toBe(1);
  });

  it('caches one renderer factory per id across change detection', async () => {
    const {fixture, table} = await createHost();

    const before = (table as unknown as {columns: Column<unknown>[]}).columns[0].renderer;

    fixture.componentInstance.rows.set([{id: 'a', name: 'B'}]);
    fixture.detectChanges();
    await (table as unknown as {updateComplete: Promise<unknown>}).updateComplete;

    const after = (table as unknown as {columns: Column<unknown>[]}).columns[0].renderer;

    expect(after).toBe(before);
  });
});

describe('MndwCellTemplateContext', () => {
  it('declares the $implicit/row/value/colId shape', () => {
    const context = {$implicit: {id: 'a', name: 'A'}, row: {id: 'a', name: 'A'}, value: 'A', colId: 'name'};

    expect(context).toEqual({$implicit: context.row, row: context.row, value: context.value, colId: context.colId});
  });
});
