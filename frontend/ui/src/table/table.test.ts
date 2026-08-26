import {nonNull, shadowOf, shadowQuery} from '@mndw/sdk/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from '../checkbox/checkbox.js';
import {setMndwUiLocale} from '../i18n.js';
import {type UiLayer, type UiLayerOptions, type UiOverlayProvider, setOverlayProvider} from '../overlay.js';
import {defineComponents, resetUiTestState} from '../testing/index.js';
import {column} from './table-builder.js';
import {MNDW_COLUMN_MENU_TAG, MndwColumnMenu} from './column-menu.js';
import {MNDW_TABLE_TAG, MndwTable} from './table.js';
import {createFakeTableGeometryProvider} from './table-test-geometry.js';
import {
  MNDW_ROW_EXPAND_EVENT,
  type MndwColumnVisibilityChangeDetail,
  type MndwErrorDetail,
  type MndwRowExpandDetail,
  type MndwRowReorderDetail,
  type MndwSortChangeDetail,
} from './table-types.js';

interface TestRow {
  id: string;
  name: string;
  count: number;
  active: boolean;
  node: {title: string};
}

const rows: TestRow[] = [
  {id: 'a', name: 'cherry', count: 10, active: true, node: {title: 'Node A'}},
  {id: 'b', name: 'apple', count: 3, active: false, node: {title: 'Node B'}},
  {id: 'c', name: 'Banana', count: 7, active: true, node: {title: 'Node C'}},
];

function makeColumns() {
  return [
    column<TestRow>()({id: 'name', label: 'Name', accessor: (row) => row.name, sortable: true}),
    column<TestRow>()({id: 'count', label: 'Count', accessor: (row) => row.count, kind: 'number', sortable: true}),
    column<TestRow>()({id: 'active', label: 'Active', accessor: (row) => row.active, kind: 'boolean'}),
    column<TestRow>()({id: 'title', label: 'Title', accessor: (row) => row.node.title}),
  ];
}

defineComponents(
  [MNDW_TABLE_TAG, MndwTable],
  [MNDW_CHECKBOX_TAG, MndwCheckbox],
  [MNDW_COLUMN_MENU_TAG, MndwColumnMenu],
);

afterEach(() => {
  resetUiTestState();
});

function makeTable(): MndwTable<TestRow> {
  const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<TestRow>;

  document.body.appendChild(el);

  return el;
}

describe('MndwTable rendering and properties', () => {
  it('renders a bounded virtual window with native spacer rows', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 120},
      header: {width: 480, height: 32},
      rowHeights: new Map(),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);
    const virtualRows = Array.from({length: 20}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));

    el.columns = [{id: 'name', label: 'Name', accessor: (row: {id: string; name: string}) => row.name}];
    el.rows = virtualRows;
    el.rowKey = 'id';
    el.virtual = true;
    el.overscan = 0;
    document.body.append(el);
    await el.updateComplete;

    const summaryRows = el.shadowRoot?.querySelectorAll('[part="row"]') ?? [];
    const spacers = el.shadowRoot?.querySelectorAll('[part="virtual-spacer"]') ?? [];

    expect(summaryRows.length).toBeGreaterThan(0);
    expect(summaryRows.length).toBeLessThan(virtualRows.length);
    expect(spacers.length).toBeLessThanOrEqual(2);

    for (const spacer of spacers) {
      expect(spacer.parentElement?.tagName).toBe('TBODY');
      expect(spacer.querySelectorAll('td')).toHaveLength(1);
    }
  });

  it('keeps selection and sorting logical when rows are off-screen', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 80},
      header: {width: 480, height: 20},
      rowHeights: new Map(),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);
    const virtualRows = Array.from({length: 12}, (_value, index) => ({
      id: `row-${index}`,
      name: `Name ${String(12 - index).padStart(2, '0')}`,
    }));
    const selection = vi.fn<(event: Event) => void>();

    el.columns = [
      column<{id: string; name: string}>()({
        id: 'name',
        label: 'Name',
        accessor: (row) => row.name,
        sortable: true,
      }),
    ];
    el.rows = virtualRows;
    el.rowKey = 'id';
    el.virtual = true;
    el.overscan = 0;
    el.selectable = true;
    el.addEventListener('mndwselectionchange', selection);
    el.sort = {columnId: 'name', direction: 'asc'};
    document.body.append(el);
    await el.updateComplete;

    const firstRendered = shadowQuery<HTMLElement>(el, '[part="row"]');

    expect(firstRendered.getAttribute('data-row-key')).toBe('row-11');

    const selectAll = shadowQuery<HTMLElement>(el, '[part="select-all"]');

    selectAll.click();

    expect(selection).toHaveBeenCalledWith(
      expect.objectContaining({detail: {selected: virtualRows.map((row) => row.id).reverse()}}),
    );
  });

  it('samples rendered summary and detail rows through one scheduled geometry frame', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 120},
      header: {width: 480, height: 32},
      rowHeights: new Map([
        ['row-0', {summary: 60, detail: 130}],
        ['row-1', {summary: 45}],
      ]),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);

    el.columns = [{id: 'name', label: 'Name', accessor: (row) => row.name}];
    el.rows = Array.from({length: 12}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    el.rowKey = 'id';
    el.virtual = true;
    el.overscan = 0;
    el.expandable = true;
    el.expanded = ['row-0'];
    el.expandedRenderer = () => ({
      mount: (): void => {},
      update: (): void => {},
      destroy: (): void => {},
    });
    document.body.append(el);

    await el.updateComplete;
    provider.flushFrame();
    await el.updateComplete;
    provider.flushFrame();
    await el.updateComplete;

    const viewport = shadowQuery<HTMLElement>(el, '[part="viewport"]');
    const header = shadowQuery<HTMLElement>(el, '[part="header-row"]');
    const renderedRows = [...shadowOf(el).querySelectorAll<HTMLElement>('[part="row"], [part="detail-row"]')];
    const frame = vi.spyOn(provider, 'requestAnimationFrame');

    provider.deliverResize([viewport, header, ...renderedRows]);
    provider.deliverResize([viewport, header, ...renderedRows]);

    expect(frame).toHaveBeenCalledTimes(1);

    provider.flushFrame();
    await el.updateComplete;

    expect(shadowOf(el).querySelectorAll('[part="row"]').length).toBeGreaterThan(0);
    expect(shadowOf(el).querySelectorAll('[part="detail-row"]').length).toBeGreaterThan(0);
  });

  it('ignores sub-pixel row changes without rebuilding the rendered window', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 120},
      header: {width: 480, height: 32},
      rowHeights: new Map(
        Array.from({length: 12}, (_value, index) => [`row-${index}`, {summary: 40}] as const),
      ),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);
    const update = vi.spyOn(el, 'requestUpdate');

    el.columns = [{id: 'name', label: 'Name', accessor: (row) => row.name}];
    el.rows = Array.from({length: 12}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    el.rowKey = 'id';
    el.virtual = true;
    el.overscan = 0;
    document.body.append(el);
    await el.updateComplete;
    provider.flushFrame();
    await el.updateComplete;
    provider.flushFrame();
    await el.updateComplete;
    provider.flushFrame();
    await el.updateComplete;
    provider.flushFrame();
    await el.updateComplete;
    update.mockClear();

    provider.setRowHeights(new Map([['row-0', {summary: 40.1}]]));

    const row = nonNull(shadowOf(el).querySelector<HTMLElement>('[part="row"]'), 'rendered row');

    provider.deliverResize([row]);
    provider.flushFrame();
    await el.updateComplete;

    expect(update).not.toHaveBeenCalled();
  });

  it('scrolls to valid logical rows through the provider and rejects absent keys', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 100},
      header: {width: 480, height: 20},
      rowHeights: new Map(
        Array.from({length: 8}, (_value, index) => [`row-${index}`, {summary: 40}] as const),
      ),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);
    const setScrollTop = vi.spyOn(provider, 'setViewportScrollTop');

    el.columns = [{id: 'name', label: 'Name', accessor: (row) => row.name}];
    el.rows = Array.from({length: 8}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    el.rowKey = 'id';
    el.virtual = true;
    el.estimatedRowHeight = 40;
    el.overscan = 0;
    document.body.append(el);
    await el.updateComplete;

    for (let index = 0; index < 4; index += 1) {
      provider.flushFrame();
      await el.updateComplete;
    }

    setScrollTop.mockClear();

    expect(el.scrollToRow('missing', {align: 'start'})).toBe(false);
    expect(setScrollTop).not.toHaveBeenCalled();
    expect(el.scrollToRow('row-3', {align: 'start'})).toBe(true);
    expect(setScrollTop).toHaveBeenLastCalledWith(expect.anything(), 140);

    provider.setScrollTop(0);
    expect(el.scrollToRow('row-3', {align: 'center'})).toBe(true);
    expect(setScrollTop).toHaveBeenLastCalledWith(expect.anything(), 110);

    provider.setScrollTop(0);
    expect(el.scrollToRow('row-3', {align: 'end'})).toBe(true);
    expect(setScrollTop).toHaveBeenLastCalledWith(expect.anything(), 80);

    provider.setScrollTop(110);
    expect(el.scrollToRow('row-3', {align: 'nearest'})).toBe(true);
    expect(setScrollTop).toHaveBeenLastCalledWith(expect.anything(), 110);
  });

  it('preserves the first visible key and intra-row offset when a measured row above changes', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 100},
      header: {width: 480, height: 20},
      rowHeights: new Map(
        Array.from({length: 8}, (_value, index) => [`row-${index}`, {summary: 40}] as const),
      ),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);

    el.columns = [{id: 'name', label: 'Name', accessor: (row) => row.name}];
    el.rows = Array.from({length: 8}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    el.rowKey = 'id';
    el.virtual = true;
    el.overscan = 200;
    document.body.append(el);
    await el.updateComplete;

    for (let index = 0; index < 5; index += 1) {
      provider.flushFrame();
      await el.updateComplete;
    }

    provider.setScrollTop(160);

    const viewport = shadowQuery<HTMLElement>(el, '[part="viewport"]');

    provider.deliverResize([viewport]);
    provider.flushFrame();
    await el.updateComplete;

    provider.setRowHeights(new Map([['row-0', {summary: 70}]]));

    const firstRow = nonNull(
      [...shadowOf(el).querySelectorAll<HTMLElement>('[part="row"]')]
        .find((row) => row.getAttribute('data-row-key') === 'row-0'),
      'row-0',
    );

    provider.deliverResize([firstRow]);
    provider.flushFrame();
    await el.updateComplete;

    expect(provider.getViewportScrollTop(viewport)).toBe(190);
  });

  it('reports complete logical row counts and indices for virtual summary/detail rows', async () => {
    const provider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 100},
      header: {width: 480, height: 20},
      rowHeights: new Map(),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const el = new MndwTable<{id: string; name: string}>(provider);

    el.columns = [{id: 'name', label: 'Name', accessor: (row) => row.name}];
    el.rows = Array.from({length: 10}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));
    el.rowKey = 'id';
    el.virtual = true;
    el.overscan = 0;
    el.expandable = true;
    el.expanded = ['row-0'];
    el.expandedRenderer = () => ({mount(): void {}, update(): void {}, destroy(): void {}});
    document.body.append(el);
    await el.updateComplete;

    const table = shadowQuery<HTMLTableElement>(el, '[part="table"]');
    const header = shadowQuery<HTMLElement>(el, '[part="header-row"]');
    const contentRows = [...table.querySelectorAll<HTMLElement>('tbody tr:not([part="virtual-spacer"])')];
    const indices = contentRows.map((row) => Number(row.getAttribute('aria-rowindex')));

    expect(table.getAttribute('aria-rowcount')).toBe('12');
    expect(header.getAttribute('aria-rowindex')).toBe('1');
    expect(indices.every((index) => Number.isInteger(index) && index > 1)).toBe(true);
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
    expect(shadowOf(el).querySelectorAll('[part="virtual-spacer"][aria-rowindex]')).toHaveLength(0);
  });

  it('falls back to full rendering when virtualization conflicts with reorder or observer support', async () => {
    const reorderProvider = createFakeTableGeometryProvider({
      viewport: {width: 480, height: 100},
      header: {width: 480, height: 20},
      rowHeights: new Map(),
      defaultSummaryHeight: 40,
      defaultDetailHeight: 160,
      scrollTop: 0,
    });
    const reorderTable = new MndwTable<{id: string; name: string}>(reorderProvider);
    const allRows = Array.from({length: 8}, (_value, index) => ({id: `row-${index}`, name: `Row ${index}`}));

    reorderTable.columns = [{id: 'name', label: 'Name', accessor: (row) => row.name}];
    reorderTable.rows = allRows;
    reorderTable.rowKey = 'id';
    reorderTable.virtual = true;
    reorderTable.reorderable = true;
    document.body.append(reorderTable);
    await reorderTable.updateComplete;

    expect(reorderTable.getAttribute('data-mndw-virtual-inactive')).toBe('reorderable');
    expect(reorderTable.shadowRoot?.querySelectorAll('[part="row"]')).toHaveLength(allRows.length);
    expect(reorderTable.shadowRoot?.querySelectorAll('[part="virtual-spacer"]')).toHaveLength(0);

    const unavailableProvider = {
      ...createFakeTableGeometryProvider({
        viewport: {width: 480, height: 100},
        header: {width: 480, height: 20},
        rowHeights: new Map(),
        defaultSummaryHeight: 40,
        defaultDetailHeight: 160,
        scrollTop: 0,
      }),
      createResizeObserver: (): null => null,
    };
    const unavailableTable = new MndwTable<{id: string; name: string}>(unavailableProvider);

    unavailableTable.columns = reorderTable.columns;
    unavailableTable.rows = allRows;
    unavailableTable.rowKey = 'id';
    unavailableTable.virtual = true;
    document.body.append(unavailableTable);
    await unavailableTable.updateComplete;

    expect(unavailableTable.getAttribute('data-mndw-virtual-inactive')).toBe('resize-observer-unavailable');
    expect(unavailableTable.shadowRoot?.querySelectorAll('[part="row"]')).toHaveLength(allRows.length);
    expect(unavailableTable.shadowRoot?.querySelectorAll('[part="virtual-spacer"]')).toHaveLength(0);
  });

  it('defaults virtualization tuning and reflects valid public properties', async () => {
    const el = makeTable();

    expect(el.virtual).toBe(false);
    expect(el.estimatedRowHeight).toBe(49);
    expect(el.overscan).toBe(400);

    el.virtual = true;
    el.estimatedRowHeight = 72;
    el.overscan = 0;
    await el.updateComplete;

    expect(el.hasAttribute('virtual')).toBe(true);
    expect(el.getAttribute('estimated-row-height')).toBe('72');
    expect(el.getAttribute('overscan')).toBe('0');
  });

  it('normalizes invalid tuning without creating data violations', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.estimatedRowHeight = Number.NaN;
    el.overscan = -1;
    await el.updateComplete;

    expect(el.estimatedRowHeight).toBe(Number.NaN);
    expect(el.overscan).toBe(-1);
    expect(shadowOf(el).querySelector('[part="error"]')).toBeNull();
  });

  it('renders a native table with caption, headers, and rows', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.caption = 'Devices';
    el.columnMenu = false;
    await el.updateComplete;

    const shadow = shadowOf(el);
    const caption = shadow.querySelector('caption');

    expect(caption?.textContent).toBe('Devices');
    expect(shadow.querySelectorAll('thead th').length).toBe(4);
    expect(shadow.querySelectorAll('tbody tr').length).toBe(3);
    expect(shadow.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(shadow.querySelector('[part="viewport"]')).not.toBeNull();
    expect(shadow.querySelector('[part="table"]')).not.toBeNull();
  });

  it('uses table-layout fixed and internal viewport overflow', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    const table = shadowQuery<HTMLTableElement>(el, 'table');
    const viewport = shadowQuery<HTMLElement>(el, '[part="viewport"]');

    expect(table.getAttribute('part')).toBe('table');
    expect(viewport).not.toBeNull();
    expect(viewport.classList.contains('mndw-table-viewport')).toBe(true);
    expect(table.parentElement).toBe(viewport);
  });

  it('reflects selectable and reorderable booleans', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.reorderable = true;
    await el.updateComplete;

    expect(el.hasAttribute('selectable')).toBe(true);
    expect(el.hasAttribute('reorderable')).toBe(true);
    expect(shadowOf(el).querySelector('[part="select-all"]')).not.toBeNull();
    expect(shadowOf(el).querySelector('[part="drag-handle"]')).not.toBeNull();
  });

  it('re-renders localized aria labels when the locale changes', async () => {
    const element = makeTable();

    element.columns = makeColumns();
    element.rows = rows;
    element.rowKey = 'id';
    element.selectable = true;
    await element.updateComplete;

    const selectAll = shadowQuery<HTMLElement>(element, '[part="select-all"]');

    expect(selectAll.getAttribute('aria-label')).toBe('Select all');

    setMndwUiLocale('ru');
    await element.updateComplete;

    expect(selectAll.getAttribute('aria-label')).toBe('Выбрать все');
  });

  it('does not re-render after disconnect when the locale changes', async () => {
    const element = makeTable();

    element.columns = makeColumns();
    element.rows = rows;
    element.rowKey = 'id';
    element.selectable = true;
    await element.updateComplete;

    const requestUpdate = vi.spyOn(element, 'requestUpdate');

    element.remove();
    requestUpdate.mockClear();

    setMndwUiLocale('ru');

    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it('exposes explicit string attributes', async () => {
    const el = makeTable();

    el.setAttribute('row-key', 'id');
    el.setAttribute('sort-mode', 'manual');
    el.setAttribute('empty-label', 'Nothing');
    el.setAttribute('column-menu-panel-class', 'demo');
    await el.updateComplete;

    expect(el.rowKey).toBe('id');
    expect(el.sortMode).toBe('manual');
    expect(el.emptyLabel).toBe('Nothing');
    expect(el.columnMenuPanelClass).toBe('demo');
  });

  it('renders the empty part when rows is empty', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = [];
    el.rowKey = 'id';
    el.emptyLabel = 'No devices';
    await el.updateComplete;

    expect(shadowOf(el).querySelector('[part="empty"]')?.textContent).toBe('No devices');
  });

  it('renders the error part with role alert when data is invalid', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = [
      {id: 'a', name: 'x', count: 0, active: false, node: {title: 't'}},
      {id: 'a', name: 'y', count: 0, active: false, node: {title: 't'}},
    ];
    el.rowKey = 'id';
    el.labels = {invalidData: 'Bad data'};
    await el.updateComplete;

    const errorPart = shadowOf(el).querySelector('[part="error"]');

    expect(errorPart?.getAttribute('role')).toBe('alert');
    expect(errorPart?.textContent).toBe('Bad data');
  });

  it('does not render reserved synthetic columns', async () => {
    const el = makeTable();

    el.columns = [
      ...makeColumns(),
      {id: '__mndw_detail__', label: 'Reserved', accessor: (row: TestRow) => row.name},
    ];
    el.rows = rows;
    el.rowKey = 'id';
    el.columnMenu = false;
    await el.updateComplete;

    expect(shadowOf(el).querySelectorAll('thead th')).toHaveLength(4);
    expect(shadowOf(el).querySelector('th')?.textContent).not.toContain('Reserved');
  });

  it('renders no expand cell when not expandable (backward compat)', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    expect(shadowOf(el).querySelector('[part="expand-toggle"]')).toBeNull();
  });

  it('renders a toggle per row and a detail row with correct colspan when expanded', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.columnMenu = true;
    el.expandable = true;
    el.expanded = ['a'];
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    expect(shadowOf(el).querySelectorAll('[part="expand-toggle"]')).toHaveLength(rows.length);
    expect(
      shadowOf(el).querySelector('[part="detail-cell"]')
        ?.getAttribute('colspan'),
    ).toBe('7');
    expect(shadowOf(el).querySelectorAll('[part="detail-row"]')).toHaveLength(1);
  });

  it('computes detail colspan across cell combinations', async () => {
    const colspanFor = async (setup: (table: MndwTable<TestRow>) => void): Promise<string | null> => {
      const el = makeTable();

      el.columns = makeColumns();
      el.rows = rows;
      el.rowKey = 'id';
      el.expandable = true;
      el.expanded = ['a'];
      el.columnMenu = false;
      el.selectable = false;
      el.reorderable = false;
      el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
      setup(el);
      await el.updateComplete;

      return shadowOf(el).querySelector('[part="detail-cell"]')
        ?.getAttribute('colspan') ?? null;
    };

    expect(await colspanFor(() => {})).toBe('5');
    expect(
      await colspanFor((table) => {
        table.selectable = true;
      }),
    ).toBe('6');
    expect(
      await colspanFor((table) => {
        table.columnMenu = true;
      }),
    ).toBe('6');
    expect(
      await colspanFor((table) => {
        table.reorderable = true;
        table.sort = null;
      }),
    ).toBe('6');
    expect(
      await colspanFor((table) => {
        table.reorderable = true;
        table.sort = {columnId: 'name', direction: 'asc'};
      }),
    ).toBe('5');
    expect(
      await colspanFor((table) => {
        table.hiddenColumns = ['count'];
      }),
    ).toBe('4');
  });

  it('places the toggle cell first for leading and last for trailing', async () => {
    const makeHeaderCells = async (placement: 'leading' | 'trailing'): Promise<Element[]> => {
      const el = makeTable();

      el.columns = makeColumns();
      el.rows = rows;
      el.rowKey = 'id';
      el.expandable = true;
      el.toggleCell = placement;
      el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
      await el.updateComplete;

      return [...shadowOf(el).querySelectorAll('[part~="header-cell"]')];
    };

    const leading = await makeHeaderCells('leading');

    expect(leading[0]?.getAttribute('part')).toContain('expand-cell');

    const trailing = await makeHeaderCells('trailing');

    expect(trailing.at(-1)?.getAttribute('part')).toContain('expand-cell');
  });

  it('places the toggle cell after the configured column', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.expandable = true;
    el.toggleAfterColumn = 'name';
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    const headerCells = [...shadowOf(el).querySelectorAll('[part~="header-cell"]')];
    const rowCells = [...shadowOf(el).querySelectorAll('[part="row"]:first-of-type > [part~="cell"]')];

    expect(headerCells[0]?.textContent).toContain('Name');
    expect(headerCells[1]?.getAttribute('part')).toContain('expand-cell');
    expect(rowCells[0]?.textContent).toContain('cherry');
    expect(rowCells[1]?.getAttribute('part')).toContain('expand-cell');
  });

  it('applies declared column widths to header and body cells', async () => {
    const el = makeTable();
    const columns = makeColumns();

    columns[0] = {...columns[0], width: '180px'};

    el.columns = columns;
    el.rows = rows;
    el.rowKey = 'id';
    el.columnMenu = false;
    await el.updateComplete;

    const header = shadowOf(el).querySelector<HTMLTableCellElement>('thead th');
    const cell = shadowOf(el).querySelector<HTMLTableCellElement>('[part="row"] td');

    expect(header?.style.width).toBe('180px');
    expect(cell?.style.width).toBe('180px');
  });

  it('keeps selection utility cells narrow', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    await el.updateComplete;

    const selectCell = shadowQuery<HTMLElement>(el, '[part~="select-cell"]');

    expect(getComputedStyle(selectCell).width).toBe('40px');
  });

  it('applies row cell styling to compound expand cells and enlarges the toggle', async () => {
    const previousTextLg = document.documentElement.style.getPropertyValue('--mndw-text-lg');

    document.documentElement.style.setProperty('--mndw-text-lg', '16px');

    try {
      const el = makeTable();

      el.columns = makeColumns();
      el.rows = rows;
      el.rowKey = 'id';
      el.expandable = true;
      el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
      await el.updateComplete;

      const regularCell = shadowQuery<HTMLElement>(el, '[part="row"] > [part="cell"]');
      const expandCell = shadowQuery<HTMLElement>(el, '[part="row"] > [part="cell expand-cell"]');
      const expandToggle = shadowQuery<HTMLButtonElement>(el, '[part="expand-toggle"]');

      expect(getComputedStyle(expandCell).borderBottomStyle).toBe(getComputedStyle(regularCell).borderBottomStyle);
      expect(getComputedStyle(expandCell).borderBottomWidth).toBe(getComputedStyle(regularCell).borderBottomWidth);
      expect(getComputedStyle(expandToggle).fontSize).toBe('16px');
    } finally {
      if (previousTextLg === '') {
        document.documentElement.style.removeProperty('--mndw-text-lg');
      } else {
        document.documentElement.style.setProperty('--mndw-text-lg', previousTextLg);
      }
    }
  });

  it('labels the toggle with the expand/collapse label', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.expandable = true;
    el.expanded = [];
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    expect(
      shadowOf(el).querySelector('[part="expand-toggle"]')
        ?.getAttribute('aria-label'),
    ).toMatch(/expand/i);
  });

  it('keeps header and body column counts aligned when reorderable and sorted', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.reorderable = true;
    el.selectable = false;
    el.columnMenu = false;
    el.sort = {columnId: 'name', direction: 'asc'};
    await el.updateComplete;

    const headerCells = shadowOf(el).querySelectorAll('[part~="header-cell"]').length;
    const firstRowCells = shadowOf(el).querySelector('[part="row"]')
      ?.querySelectorAll('[part~="cell"]').length;

    expect(headerCells).toBe(firstRowCells);
  });
});

describe('MndwTable built-in cells', () => {
  it('renders text, number, and boolean glyph cells', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    const cells = shadowOf(el).querySelectorAll('tbody tr:first-child td[part="cell"]');

    expect(cells[0].textContent).toBe('cherry');
    expect(cells[1].textContent).toBe('10');
    expect(cells[1].classList.contains('cell-kind-number')).toBe(true);
    expect(cells[2].textContent).toBe('✓');
    expect(cells[3].textContent).toBe('Node A');
  });

  it('renders a nested accessor through the default path', async () => {
    const el = makeTable();

    el.columns = [column<TestRow>()({id: 'title', label: 'Title', accessor: (row) => row.node.title})];
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    expect(shadowOf(el).querySelector('tbody td')?.textContent).toBe('Node A');
  });

  it('renders a badge with text/surface tokens and a tone dot', async () => {
    const el = makeTable();

    el.columns = [
      column<TestRow>()({
        id: 'name',
        label: 'Name',
        accessor: (row) => row.name,
        kind: 'badge',
        badge: (value) => ({text: value, tone: 'danger'}),
      }),
    ];
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    const badge = shadowOf(el).querySelector('[part="badge"]');

    expect(badge?.textContent).toContain('cherry');
    expect(shadowOf(el).querySelector('[part="badge-dot"]')).not.toBeNull();
    expect(shadowOf(el).querySelector('mndw-switch')).toBeNull();
  });
});

describe('MndwTable interaction and events', () => {
  it('emits mndwsortchange on a sortable header click', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    const sortListener = vi.fn();

    el.addEventListener('mndwsortchange', sortListener);

    const button = shadowQuery<HTMLButtonElement>(el, 'button[data-sort-column="name"]');

    button.click();

    expect(sortListener).toHaveBeenCalledTimes(1);
    expect((sortListener.mock.calls[0][0] as CustomEvent<MndwSortChangeDetail>).detail.sort).toEqual({
      columnId: 'name',
      direction: 'asc',
    });
  });

  it('sorts rows when the controlled sort prop is written back', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    el.addEventListener('mndwsortchange', (event) => {
      el.sort = (event as CustomEvent<MndwSortChangeDetail>).detail.sort;
    });

    const button = shadowQuery<HTMLButtonElement>(el, 'button[data-sort-column="name"]');

    button.click();
    await el.updateComplete;

    const firstCell = shadowOf(el).querySelector('tbody tr td[part="cell"]');

    expect(firstCell?.textContent).toBe('apple');
    expect(shadowOf(el).querySelector('th[aria-sort="ascending"]')).not.toBeNull();
  });

  it('does not mutate the controlled sort prop when the column is hidden', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.sort = {columnId: 'name', direction: 'asc'};
    el.hiddenColumns = ['name'];
    await el.updateComplete;

    expect(el.sort).toEqual({columnId: 'name', direction: 'asc'});
    expect(shadowOf(el).querySelector('th[aria-sort="ascending"]')).toBeNull();
  });

  it('emits mndwselectionchange for a row checkbox and select-all', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.selected = [];
    await el.updateComplete;

    const selectionListener = vi.fn();

    el.addEventListener('mndwselectionchange', selectionListener);

    const rowCheckbox = shadowQuery<HTMLElement>(el, 'mndw-checkbox[data-row-key="a"]');

    rowCheckbox.click();
    el.selected = ['a'];
    await el.updateComplete;

    expect(selectionListener).toHaveBeenCalled();
    expect(shadowQuery<HTMLElement>(el, 'mndw-checkbox[data-select-all]').hasAttribute('indeterminate')).toBe(true);
  });

  it('emits mndwrowreorder for keyboard move', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.reorderable = true;
    await el.updateComplete;

    const reorderListener = vi.fn();

    el.addEventListener('mndwrowreorder', reorderListener);

    const handle = shadowQuery<HTMLButtonElement>(el, 'button[part="drag-handle"][data-row-key="b"]');

    handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true, composed: true}));
    await el.updateComplete;

    expect(reorderListener).toHaveBeenCalledTimes(1);
    expect((reorderListener.mock.calls[0][0] as CustomEvent<MndwRowReorderDetail>).detail).toEqual({
      key: 'b',
      beforeKey: 'a',
    });
  });

  it('emits mndwrowexpand on chevron click without mutating state', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.expandable = true;
    el.expanded = [];
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    const detail = vi.fn();

    el.addEventListener(MNDW_ROW_EXPAND_EVENT, (event) => {
      detail((event as CustomEvent<MndwRowExpandDetail>).detail);
    });

    shadowQuery<HTMLButtonElement>(el, '[part="expand-toggle"][data-expand-key="a"]').click();

    expect(detail).toHaveBeenCalledWith({expanded: ['a']});
    expect(el.expanded).toEqual([]);
  });

  it('expandOn=row toggles on a data-cell click but not on interactive targets', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.expandable = true;
    el.expandOn = 'row';
    el.expanded = [];
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    const detail = vi.fn();

    el.addEventListener(MNDW_ROW_EXPAND_EVENT, (event) => {
      detail((event as CustomEvent<MndwRowExpandDetail>).detail);
    });

    const firstRow = nonNull(shadowOf(el).querySelector('[part="row"]'), 'first row');
    const dataCell = nonNull(
      firstRow.querySelector(
        '[part~="cell"]:not([part~="select-cell"]):not([part~="expand-cell"])',
      ),
      'data cell',
    );

    dataCell.dispatchEvent(new MouseEvent('click', {bubbles: true, composed: true}));
    expect(detail).toHaveBeenCalledTimes(1);

    detail.mockClear();
    nonNull(firstRow.querySelector('mndw-checkbox'), 'row checkbox').click();
    expect(detail).not.toHaveBeenCalled();
  });

  it('expandOn=row excludes every interactive target', async () => {
    const el = makeTable();

    el.columns = [
      column<TestRow>()({id: 'name', label: 'Name', accessor: (row) => row.name}),
      column<TestRow>()({
        id: 'controls',
        label: 'Controls',
        accessor: (row) => row.name,
        renderer: () => ({
          mount: (context) => {
            context.node.innerHTML = '<button>b</button><a href="#">a</a><input /><span data-no-expand>x</span>';
          },
          update: () => {},
          destroy: () => {},
        }),
      }),
    ];
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.reorderable = true;
    el.sort = null;
    el.expandable = true;
    el.expandOn = 'row';
    el.expanded = [];
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    const detail = vi.fn();

    el.addEventListener(MNDW_ROW_EXPAND_EVENT, () => {
      detail();
    });

    const firstRow = nonNull(shadowOf(el).querySelector('[part="row"]'), 'first row');
    const clickAndAssertNoToggle = (node: Element | null, label: string): void => {
      detail.mockClear();
      expect(node, `${label} should exist`).not.toBeNull();
      (node as HTMLElement).click();
      expect(detail, `${label} should not toggle`).not.toHaveBeenCalled();
    };
    const slotName = shadowOf(el).querySelector('[part="row"] [part~="cell"] slot')
      ?.getAttribute('name');
    const rendererNode = nonNull(el.querySelector(`[slot="${slotName}"]`), 'renderer node');

    clickAndAssertNoToggle(rendererNode.querySelector('button'), 'renderer <button>');
    clickAndAssertNoToggle(rendererNode.querySelector('a'), 'renderer <a>');
    clickAndAssertNoToggle(rendererNode.querySelector('input'), 'renderer <input>');
    clickAndAssertNoToggle(rendererNode.querySelector('[data-no-expand]'), '[data-no-expand]');
    clickAndAssertNoToggle(firstRow.querySelector('mndw-checkbox'), 'checkbox');
    clickAndAssertNoToggle(firstRow.querySelector('[part="drag-handle"]'), 'drag-handle');
  });

  it('expandOn=toggle ignores body clicks', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.expandable = true;
    el.expanded = [];
    el.expandedRenderer = () => ({mount() {}, update() {}, destroy() {}});
    await el.updateComplete;

    const detail = vi.fn();

    el.addEventListener(MNDW_ROW_EXPAND_EVENT, () => {
      detail();
    });
    nonNull(shadowOf(el).querySelector('[part~="cell"]'), 'cell').dispatchEvent(
      new MouseEvent('click', {bubbles: true, composed: true}),
    );

    expect(detail).not.toHaveBeenCalled();
  });

  it('emits mndwerror once per violation-set change', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    const errorListener = vi.fn();

    el.addEventListener('mndwerror', errorListener);

    el.rows = [
      {id: 'a', name: 'x', count: 0, active: false, node: {title: 't'}},
      {id: 'a', name: 'y', count: 0, active: false, node: {title: 't'}},
    ];
    await el.updateComplete;

    el.rows = rows;
    await el.updateComplete;

    el.rows = [
      {id: 'a', name: 'x', count: 0, active: false, node: {title: 't'}},
      {id: 'a', name: 'y', count: 0, active: false, node: {title: 't'}},
    ];
    await el.updateComplete;

    expect(errorListener).toHaveBeenCalledTimes(2);

    const detail = (errorListener.mock.calls[0][0] as CustomEvent<MndwErrorDetail>).detail;

    expect(detail.violations).toEqual([{category: 'duplicate-row-key', rowKeys: ['a']}]);
  });

  it('clears the error state on a valid reference without an error event', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = [
      {id: 'a', name: 'x', count: 0, active: false, node: {title: 't'}},
      {id: 'a', name: 'y', count: 0, active: false, node: {title: 't'}},
    ];
    el.rowKey = 'id';
    await el.updateComplete;

    const errorListener = vi.fn();

    el.addEventListener('mndwerror', errorListener);

    el.rows = rows;
    await el.updateComplete;

    expect(shadowOf(el).querySelector('[part="error"]')).toBeNull();
    expect(errorListener).not.toHaveBeenCalled();
  });

  it('does not reconcile in-place mutation but does on a new reference', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = [...rows];
    el.rowKey = 'id';
    await el.updateComplete;

    el.rows.push({id: 'd', name: 'date', count: 1, active: false, node: {title: 't'}});
    await el.updateComplete;

    expect(shadowOf(el).querySelectorAll('tbody tr').length).toBe(3);

    el.rows = [
      ...rows,
      {id: 'd', name: 'date', count: 1, active: false, node: {title: 't'}},
    ];
    await el.updateComplete;

    expect(shadowOf(el).querySelectorAll('tbody tr').length).toBe(4);
  });

  it('applies the rowLabel and labels formatter output', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.rowLabel = (row) => `Device ${row.name}`;
    el.labels = {selectRow: (name) => `Select ${name}`};
    await el.updateComplete;

    const checkbox = shadowOf(el).querySelector('mndw-checkbox[data-row-key="a"]');

    expect(checkbox?.getAttribute('aria-label')).toBe('Select Device cherry');
  });
});

describe('MndwTable lifecycle', () => {
  it('mounts the detail renderer only when expanded and destroys on collapse', async () => {
    const el = makeTable();
    const renderer = {mount: vi.fn(), update: vi.fn(), destroy: vi.fn()};

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.expandable = true;
    el.expandedRenderer = () => renderer;
    el.expanded = [];
    await el.updateComplete;

    expect(renderer.mount).not.toHaveBeenCalled();

    el.expanded = ['a'];
    await el.updateComplete;

    expect(renderer.mount).toHaveBeenCalledTimes(1);

    el.expanded = [];
    await el.updateComplete;

    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('mounts once and updates on same-key replacement', async () => {
    const el = makeTable();
    const renderer = {mount: vi.fn(), update: vi.fn(), destroy: vi.fn()};

    el.columns = [column<TestRow>()({id: 'name', label: 'Name', accessor: (r) => r.name, renderer: () => renderer})];
    el.rows = [rows[0]];
    el.rowKey = 'id';
    await el.updateComplete;

    expect(renderer.mount).toHaveBeenCalledTimes(1);

    el.rows = [{...rows[0], name: 'cherry2'}];
    await el.updateComplete;

    expect(renderer.mount).toHaveBeenCalledTimes(1);
    expect(renderer.update).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });

  it('destroys custom cells on disconnect', async () => {
    const el = makeTable();
    const renderer = {mount: vi.fn(), update: vi.fn(), destroy: vi.fn()};

    el.columns = [column<TestRow>()({id: 'name', label: 'Name', accessor: (r) => r.name, renderer: () => renderer})];
    el.rows = [rows[0]];
    el.rowKey = 'id';
    await el.updateComplete;

    expect(el.querySelectorAll('[slot]').length).toBe(1);

    el.remove();
    await el.updateComplete;

    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('MndwTable column menu', () => {
  function makeOverlayProvider(): {provider: UiOverlayProvider; openCalls: UiLayerOptions[]; layer: UiLayer} {
    const openCalls: UiLayerOptions[] = [];
    const contentElement = document.createElement('div');

    document.body.appendChild(contentElement);

    const layer: UiLayer = {
      contentElement,
      closed: new Promise(() => {}),
      close: vi.fn(),
      reposition: vi.fn(),
    };
    const provider: UiOverlayProvider = {
      open(options: UiLayerOptions): UiLayer {
        openCalls.push(options);

        return layer;
      },
    };

    return {provider, openCalls, layer};
  }

  it('opens a popover layer without a focus trap and passes the panel class', async () => {
    const {provider, openCalls} = makeOverlayProvider();

    setOverlayProvider(provider);

    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.columnMenuPanelClass = 'demo-panel';
    await el.updateComplete;

    shadowQuery<HTMLButtonElement>(el, '[part="column-menu-trigger"]').click();
    await el.updateComplete;

    expect(openCalls).toHaveLength(1);
    expect(openCalls[0].trapFocus).toBe(false);
    expect(openCalls[0].restoreFocus).toBe(false);
    expect(openCalls[0].className).toBe('demo-panel');
  });

  it('emits mndwcolumnvisibilitychange with the requested hidden list in controlled mode', async () => {
    const {provider, layer} = makeOverlayProvider();

    setOverlayProvider(provider);

    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.hiddenColumns = [];
    await el.updateComplete;

    const visibilityListener = vi.fn();

    el.addEventListener('mndwcolumnvisibilitychange', visibilityListener);

    shadowQuery<HTMLButtonElement>(el, '[part="column-menu-trigger"]').click();
    await el.updateComplete;

    const menu = nonNull(layer.contentElement.querySelector('mndw-column-menu'), 'mndw-column-menu');

    await menu.updateComplete;

    shadowQuery<HTMLButtonElement>(menu, 'button[data-column-id="name"]').click();

    expect(visibilityListener).toHaveBeenCalledTimes(1);
    expect((visibilityListener.mock.calls[0][0] as CustomEvent<MndwColumnVisibilityChangeDetail>).detail.hidden)
      .toEqual(['name']);
  });

  it('renders no trigger or panel when columnMenu is false', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.columnMenu = false;
    await el.updateComplete;

    expect(shadowOf(el).querySelector('[part="column-menu-trigger"]')).toBeNull();
  });
});

describe('MndwTable DOM contract', () => {
  it('emits exact part attributes, align classes, and button types', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    el.reorderable = true;
    el.columnMenu = true;
    await el.updateComplete;

    const root = shadowOf(el);

    expect(root.querySelector('th[part="header-cell select-cell"]')).not.toBeNull();
    expect(root.querySelector('[part="select-all"]')).not.toBeNull();

    const sortButton = root.querySelector<HTMLButtonElement>('button[data-sort-column="name"]');

    expect(sortButton?.type).toBe('button');

    const menuTrigger = root.querySelector<HTMLButtonElement>('button[part="column-menu-trigger"]');

    expect(menuTrigger?.type).toBe('button');

    // reorderable && unsorted -> drag handles present with type=button
    const handle = root.querySelector<HTMLButtonElement>('button[part="drag-handle"]');

    expect(handle?.type).toBe('button');

    // number column cells carry cell-kind-number, one per row
    expect(root.querySelectorAll('td.cell-kind-number').length).toBe(rows.length);

    expect(root.querySelectorAll('[part="row"]').length).toBe(rows.length);
    expect(root.querySelector('td[part="select-cell cell"]')).not.toBeNull();
  });

  it('omits the class attribute on cells without align or kind classes', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    // 'name' column: no align, not number -> its td must have no class attribute
    const firstRow = shadowOf(el).querySelector('[part="row"]');
    const nameCell = firstRow?.querySelector('td[part="cell"]');

    expect(nameCell).not.toBeNull();
    expect(nameCell?.hasAttribute('class')).toBe(false);
  });
});

describe('MndwTable node reuse (repeat migration)', () => {
  it('reuses shadow row and cell instances across an unrelated update', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.selectable = true;
    await el.updateComplete;

    const root = shadowOf(el);
    const rowBefore = root.querySelector('[part="row"]');
    const cellBefore = rowBefore?.querySelector('td[part="cell"]');

    el.selected = ['a']; // unrelated to row structure
    await el.updateComplete;

    const rowAfter = root.querySelector('[part="row"]');
    const cellAfter = rowAfter?.querySelector('td[part="cell"]');

    expect(rowAfter).toBe(rowBefore); // FAILS pre-migration (buildTable recreates)
    expect(cellAfter).toBe(cellBefore);
  });

  it('reuses the same shadow <tr> instance when rows reorder', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = [rows[0], rows[1], rows[2]];
    el.rowKey = 'id';
    await el.updateComplete;

    const root = shadowOf(el);
    const findByName = (name: string): Element | undefined =>
      [...root.querySelectorAll('[part="row"]')].find(
        (tr) => tr.querySelector('td[part="cell"]')?.textContent === name,
      );

    const trackedRowA = findByName('cherry'); // row id 'a'

    expect(trackedRowA).toBeDefined();

    el.rows = [rows[2], rows[1], rows[0]];
    await el.updateComplete;

    expect(findByName('cherry')).toBe(trackedRowA); // FAILS pre-migration
  });

  it('keeps a custom-renderer cell mounted once and its slot stable across updates', async () => {
    const el = makeTable();
    const renderer = {mount: vi.fn(), update: vi.fn(), destroy: vi.fn()};

    el.columns = [
      column<TestRow>()({id: 'name', label: 'Name', accessor: (r) => r.name, renderer: () => renderer}),
    ];
    el.rows = rows;
    el.rowKey = 'id';
    await el.updateComplete;

    const root = shadowOf(el);
    const slotBefore = root.querySelector('slot');

    expect(slotBefore).not.toBeNull();
    expect(renderer.mount).toHaveBeenCalledTimes(rows.length);

    el.selected = ['a'];
    await el.updateComplete;

    expect(root.querySelector('slot')).toBe(slotBefore); // FAILS pre-migration (slot recreated)
    expect(renderer.mount).toHaveBeenCalledTimes(rows.length); // no re-mount
  });

  it('reflects sort direction via aria-sort on the active header', async () => {
    const el = makeTable();

    el.columns = makeColumns();
    el.rows = rows;
    el.rowKey = 'id';
    el.sort = {columnId: 'name', direction: 'asc'};
    await el.updateComplete;

    const sortButton = shadowOf(el).querySelector('button[data-sort-column="name"]');
    const th = sortButton?.closest('th');

    expect(th?.getAttribute('aria-sort')).toBe('ascending');
  });
});
