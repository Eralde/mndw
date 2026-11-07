import {MndwTable, column} from '@mndw/ui';
import {createFakeTableGeometryProvider} from '@mndw/ui/test-geometry';
import {ApplicationRef, EnvironmentInjector} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StatefulCell, angularCellLifecycle} from './fixtures/stateful-cell.js';
import {angularCell} from './angular-cell.js';

interface Row {
  id: string;
  name: string;
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  angularCellLifecycle.constructed = 0;
  angularCellLifecycle.mounted = 0;
  angularCellLifecycle.destroyed = 0;
});

type FakeTableGeometryProvider = ReturnType<typeof createFakeTableGeometryProvider>;

async function renderInitialTable(
  table: MndwTable<Row>,
  provider: FakeTableGeometryProvider,
): Promise<HTMLElement> {
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

  return viewport;
}

async function scrollTableTo(
  table: MndwTable<Row>,
  provider: FakeTableGeometryProvider,
  viewport: HTMLElement,
  scrollTop: number,
): Promise<void> {
  provider.setScrollTop(scrollTop);
  viewport.dispatchEvent(new Event('scroll'));
  provider.flushFrame();
  await table.updateComplete;
}

function findStatefulCell(table: MndwTable<Row>, rowName: string): HTMLButtonElement | undefined {
  return [...table.querySelectorAll<HTMLButtonElement>('.stateful-cell')].find((cell) =>
    cell.textContent?.includes(rowName)
  );
}

describe('angular virtual table integration', () => {
  it('destroys offscreen cells and mounts fresh cells without recycling state across rows', async () => {
    TestBed.createComponent(StatefulCell).destroy();
    angularCellLifecycle.constructed = 0;
    angularCellLifecycle.mounted = 0;
    angularCellLifecycle.destroyed = 0;

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
        renderer: angularCell<Row, string>()(StatefulCell, environment),
      }),
    ];
    table.rows = rows;
    table.rowKey = 'id';
    table.virtual = true;
    table.estimatedRowHeight = 40;
    table.overscan = 0;

    const viewport = await renderInitialTable(table, provider);
    const firstCell = findStatefulCell(table, 'Row 0');

    expect(firstCell).not.toBeUndefined();
    firstCell?.click();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(firstCell?.textContent).toBe('1|Row 0|Row 0|name');

    const firstCellHost = firstCell?.parentElement;
    const initialComponents = angularCellLifecycle.constructed;

    await scrollTableTo(table, provider, viewport, 160);
    expect(table.querySelector('.stateful-cell')?.textContent).not.toContain('Row 0');
    expect(angularCellLifecycle.destroyed).toBeGreaterThan(0);
    expect(angularCellLifecycle.constructed).toBeGreaterThan(initialComponents);

    const otherRowCell = table.querySelector<HTMLButtonElement>('.stateful-cell');

    expect(otherRowCell?.textContent).toMatch(/^0\|Row [1-4]\|Row [1-4]\|name$/);
    expect(otherRowCell?.parentElement).not.toBe(firstCellHost);

    await scrollTableTo(table, provider, viewport, 0);

    const remountedCell = findStatefulCell(table, 'Row 0');

    expect(remountedCell?.textContent).toBe('0|Row 0|Row 0|name');
    expect(remountedCell?.parentElement).not.toBe(firstCellHost);
  });
});
