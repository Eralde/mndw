import {MndwTable, column} from '@mndw/ui';
import {createFakeTableGeometryProvider} from '@mndw/ui/test-geometry';
import {ApplicationRef, Component, EnvironmentInjector, Input} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {angularCell} from './angular-cell.js';

interface Row {
  id: string;
  name: string;
}

@Component({
  selector: 'virtual-table-cell',
  template: '<span class="angular-cell">{{ row.name }}</span>',
})
class VirtualTableCell {
  @Input()
  public row!: Row;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('angular virtual table integration', () => {
  it('destroys cells on scroll-out and mounts fresh cells on scroll-in', async () => {
    const rows = Array.from({length: 5}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 80},
      header: {width: 480, height: 20},
      rowHeights: new Map(rows.map((row) => [row.id, {summary: 40}])),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const environment = {
      applicationRef: TestBed.inject(ApplicationRef),
      environmentInjector: TestBed.inject(EnvironmentInjector),
    };
    const table = new MndwTable<Row>(provider);

    table.columns = [
      column<Row>()({
        id: 'name',
        label: 'Name',
        accessor: (row) => row.name,
        renderer: angularCell<Row, string>()(VirtualTableCell, environment),
      }),
    ];
    table.rows = rows;
    table.rowKey = 'id';
    table.virtual = true;
    table.estimatedRowHeight = 40;
    table.overscan = 0;
    document.body.append(table);
    await table.updateComplete;

    for (let index = 0; index < 5; index += 1) {
      provider.flushFrame();
      await table.updateComplete;
    }

    const viewport = table.shadowRoot?.querySelector<HTMLElement>('[part="viewport"]');

    if (viewport === null || viewport === undefined) {
      throw new Error('expected table viewport');
    }

    expect(table.querySelector('.angular-cell')).not.toBeNull();
    provider.setScrollTop(160);
    viewport.dispatchEvent(new Event('scroll'));
    provider.flushFrame();
    await table.updateComplete;
    expect(table.querySelector('.angular-cell')?.textContent).not.toContain('Row 0');

    provider.setScrollTop(0);
    viewport.dispatchEvent(new Event('scroll'));
    provider.flushFrame();
    await table.updateComplete;
    expect(table.querySelector('.angular-cell')?.textContent).toContain('Row 0');
  });
});
