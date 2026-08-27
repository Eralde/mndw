import {MNDW_TABLE_TAG, MndwTable, column, defineMndwUi} from '@mndw/ui';
import {createFakeTableGeometryProvider} from '@mndw/ui/test-geometry';
import {describe, expect, it} from 'vitest';
import TestDetailCell from './fixtures/TestDetailCell.svelte';
import TestCell from './fixtures/TestCell.svelte';
import './index.js';
import {svelteCell} from './svelte-cell.svelte.js';

describe('@mndw/ui-svelte', () => {
  it('resolves its public entrypoint', () => {
    expect(true).toBe(true);
  });

  it('mounts a row-valued svelteCell as the detail renderer', async () => {
    defineMndwUi();

    const el = document.createElement(MNDW_TABLE_TAG) as unknown as HTMLElement & Record<string, unknown>;

    el.columns = [{id: 'name', label: 'Name', accessor: (row: {name: string}) => row.name}];
    el.rows = [{name: 'alpha'}, {name: 'beta'}];
    el.rowKey = 'name';
    el.expandable = true;
    el.expandedRenderer = svelteCell<{name: string}, {name: string}>()(TestDetailCell);
    el.expanded = ['alpha'];
    document.body.appendChild(el);
    await (el as unknown as {updateComplete: Promise<unknown>}).updateComplete;

    expect(document.body.textContent).toContain('detail for');
    expect(document.body.textContent).toContain('alpha');
    el.remove();
  });

  it('destroys cells on scroll-out and mounts fresh cells on scroll-in', async () => {
    interface Row {
      id: string;
      name: string;
    }

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
        renderer: svelteCell<Row, string>()(TestCell),
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

    expect(table.querySelector('[data-col="name"]')).not.toBeNull();
    provider.setScrollTop(160);
    viewport.dispatchEvent(new Event('scroll'));
    provider.flushFrame();
    await table.updateComplete;

    expect(table.querySelector('[data-col="name"] strong')?.textContent).not.toBe('Row 0');

    provider.setScrollTop(0);
    viewport.dispatchEvent(new Event('scroll'));
    provider.flushFrame();
    await table.updateComplete;

    expect(table.querySelector('[data-col="name"] strong')?.textContent).toBe('Row 0');
    table.remove();
  });
});
