import {MndwTable, column, defineMndwUi} from '@mndw/ui';
import {createFakeTableGeometryProvider} from '@mndw/ui/test-geometry';
import {afterEach, describe, expect, it} from 'vitest';
import TestCell from './fixtures/TestCell.vue';
import {vueCell} from './vue-cell.js';

interface Row {
  id: string;
  name: string;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('vue virtual table integration', () => {
  it('destroys cells on scroll-out and mounts fresh cells on scroll-in', async () => {
    defineMndwUi();

    const rows = Array.from({length: 5}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 80},
      header: {width: 480, height: 20},
      rowHeights: new Map(rows.map((row) => [row.id, {summary: 40}])),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const table = new MndwTable<Row>(provider);

    table.columns = [
      column<Row>()({
        id: 'name',
        label: 'Name',
        accessor: (row) => row.name,
        renderer: vueCell<Row, string>()(TestCell),
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

    expect(table.querySelector('.vue-cell')).not.toBeNull();
    provider.setScrollTop(160);
    viewport.dispatchEvent(new Event('scroll'));
    provider.flushFrame();
    await table.updateComplete;
    expect(table.querySelector('.vue-cell')?.textContent).not.toContain('Row 0');

    provider.setScrollTop(0);
    viewport.dispatchEvent(new Event('scroll'));
    provider.flushFrame();
    await table.updateComplete;
    expect(table.querySelector('.vue-cell')?.textContent).toContain('Row 0');
  });
});
