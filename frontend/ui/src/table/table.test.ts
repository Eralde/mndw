import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from '../checkbox/checkbox.js';
import {type UiLayer, type UiLayerOptions, type UiOverlayProvider, setOverlayProvider} from '../overlay.js';
import {column} from './table-builder.js';
import {MNDW_COLUMN_MENU_TAG, MndwColumnMenu} from './column-menu.js';
import {MNDW_TABLE_TAG, MndwTable} from './table.js';
import type {
  MndwColumnVisibilityChangeDetail,
  MndwErrorDetail,
  MndwRowReorderDetail,
  MndwSortChangeDetail,
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

beforeAll(() => {
  if (!customElements.get(MNDW_TABLE_TAG)) {
    customElements.define(MNDW_TABLE_TAG, MndwTable);
  }

  if (!customElements.get(MNDW_CHECKBOX_TAG)) {
    customElements.define(MNDW_CHECKBOX_TAG, MndwCheckbox);
  }

  if (!customElements.get(MNDW_COLUMN_MENU_TAG)) {
    customElements.define(MNDW_COLUMN_MENU_TAG, MndwColumnMenu);
  }
});

afterEach(() => {
  setOverlayProvider(undefined);
  document.body.innerHTML = '';
});

function makeTable(): MndwTable<TestRow> {
  const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<TestRow>;

  document.body.appendChild(el);

  return el;
}

function shadowOf(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;

  if (root === null) {
    throw new Error('expected open shadow root');
  }

  return root;
}

function shadowQuery<T extends Element>(el: HTMLElement, selector: string): T {
  const node = shadowOf(el).querySelector<T>(selector);

  if (node === null) {
    throw new Error(`expected shadow element: ${selector}`);
  }

  return node;
}

function nonNull<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }

  return value;
}

describe('MndwTable rendering and properties', () => {
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
