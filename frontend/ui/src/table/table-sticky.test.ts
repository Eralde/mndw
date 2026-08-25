import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from '../checkbox/checkbox.js';
import {MNDW_COLUMN_MENU_TAG, MndwColumnMenu} from './column-menu.js';
import {column} from './table-builder.js';
import {MNDW_TABLE_TAG, MndwTable} from './table.js';

interface Row {
  id: string;
  name: string;
}

beforeAll(() => {
  for (
    const [tag, ctor] of [[MNDW_TABLE_TAG, MndwTable], [MNDW_CHECKBOX_TAG, MndwCheckbox], [
      MNDW_COLUMN_MENU_TAG,
      MndwColumnMenu,
    ]] as const
  ) {
    if (!customElements.get(tag)) {
      customElements.define(tag, ctor as CustomElementConstructor);
    }
  }
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function makeTable(): MndwTable<Row> {
  const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<Row>;

  el.columns = [{id: 'name', label: 'Name', accessor: (row: Row) => row.name}];
  el.rows = [{id: 'a', name: 'Alpha'}];
  el.rowKey = 'id';
  document.body.appendChild(el);

  return el;
}

const styleText = (): string => String((MndwTable as unknown as {styles: unknown}).styles);
const hasRule = (text: string, selector: string, ...declarations: string[]): boolean => {
  const flat = text.replace(/\s+/g, ' ');
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = flat.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));

  return match !== null && declarations.every((declaration) => match[1].includes(declaration.replace(/\s+/g, ' ')));
};

function requiredElement<T extends Element>(root: ParentNode | null | undefined, selector: string): T {
  const element = root?.querySelector<T>(selector);

  if (element === null || element === undefined) {
    throw new Error(`missing test element: ${selector}`);
  }

  return element;
}

describe('MndwTable new API surface', () => {
  it('defaults layout to fixed and reflects layout/sticky-header attributes', async () => {
    const el = makeTable();

    await el.updateComplete;
    expect(el.layout).toBe('fixed');
    expect(el.getAttribute('layout')).toBe('fixed');

    el.layout = 'auto';
    el.stickyHeader = true;
    await el.updateComplete;
    expect(el.getAttribute('layout')).toBe('auto');
    expect(el.hasAttribute('sticky-header')).toBe(true);
  });

  it('accepts min-width via property and via the min-width attribute', async () => {
    const el = makeTable();

    el.minWidth = '44rem';
    await el.updateComplete;
    expect(el.minWidth).toBe('44rem');

    const el2 = document.createElement(MNDW_TABLE_TAG) as MndwTable<Row>;

    el2.columns = [{id: 'name', label: 'Name', accessor: (row: Row) => row.name}];
    el2.rows = [{id: 'a', name: 'Alpha'}];
    el2.rowKey = 'id';
    el2.setAttribute('min-width', '30rem');
    document.body.appendChild(el2);
    await el2.updateComplete;
    expect(el2.minWidth).toBe('30rem');
  });
});

describe('MndwTable content sizing', () => {
  it('applies min-width inline on the table element', async () => {
    const el = makeTable();

    el.minWidth = '44rem';
    await el.updateComplete;

    const table = requiredElement<HTMLElement>(el.shadowRoot, '[part="table"]');

    expect(table.style.minWidth).toBe('44rem');
  });

  it('keeps fixed layout and flags inactive when auto requested under virtual', async () => {
    const el = makeTable();

    el.virtual = true;
    el.layout = 'auto';
    await el.updateComplete;
    expect(el.getAttribute('data-mndw-layout-inactive')).toBe('virtual');
  });

  it('clears the inactive flag when auto is honored', async () => {
    const el = makeTable();

    el.layout = 'auto';
    await el.updateComplete;
    expect(el.hasAttribute('data-mndw-layout-inactive')).toBe(false);
    expect(el.getAttribute('layout')).toBe('auto');
  });

  it('compiles the auto-layout and virtual-override rules', () => {
    const css = styleText();

    expect(hasRule(css, ':host([layout=\'auto\']) [part=\'table\']', 'table-layout: auto', 'width: max-content')).toBe(
      true,
    );
    expect(hasRule(css, ':host([virtual][layout=\'auto\']) [part=\'table\']', 'table-layout: fixed', 'width: 100%'))
      .toBe(true);
  });
});

describe('MndwTable pin validation', () => {
  function pinnedTable(cols: unknown[]): MndwTable<Row> {
    const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<Row>;

    el.columns = cols as never;
    el.rows = [{id: 'a', name: 'Alpha'}];
    el.rowKey = 'id';
    el.columnMenu = false;
    document.body.appendChild(el);

    return el;
  }

  it('flags a sticky column with no width as missing-width and names the id in the warning', async () => {
    const el = pinnedTable([
      column<Row>()({id: 'name', label: 'Name', accessor: (row: Row) => row.name, sticky: 'start'}),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await el.updateComplete;
    expect(el.getAttribute('data-mndw-sticky-inactive')).toBe('missing-width');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toBe('<mndw-table> sticky column "name" inactive: missing-width');
  });

  it('flags a non-leading sticky column', async () => {
    const el = pinnedTable([
      column<Row>()({id: 'name', label: 'Name', accessor: (row: Row) => row.name}),
      column<Row>()({id: 'x', label: 'X', accessor: (row: Row) => row.name, sticky: 'start', width: '8rem'}),
    ]);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await el.updateComplete;
    expect(el.getAttribute('data-mndw-sticky-inactive')).toBe('not-leading');
  });

  it('does not flag a valid pinned column', async () => {
    const el = pinnedTable([
      column<Row>()({id: 'name', label: 'Name', accessor: (row: Row) => row.name, sticky: 'start', width: '12rem'}),
    ]);

    await el.updateComplete;
    expect(el.hasAttribute('data-mndw-sticky-inactive')).toBe(false);
  });
});

describe('MndwTable pin rendering', () => {
  function twoPinned(): MndwTable<Row> {
    const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<Row>;

    el.columns = [
      column<Row>()({id: 'name', label: 'Name', accessor: (row: Row) => row.name, sticky: 'start', width: '12rem'}),
      column<Row>()({id: 'ip', label: 'IP', accessor: (row: Row) => row.name, sticky: 'start', width: '8rem'}),
      column<Row>()({id: 'x', label: 'X', accessor: (row: Row) => row.name}),
    ] as never;
    el.rows = [{id: 'a', name: 'Alpha'}];
    el.rowKey = 'id';
    el.columnMenu = false;
    document.body.appendChild(el);

    return el;
  }

  it('emits logical inset offsets and clamps pinned data cells', async () => {
    const el = twoPinned();

    await el.updateComplete;

    const bodyCells = [...(el.shadowRoot?.querySelectorAll<HTMLElement>('[part="row"] [part~="cell"]') ?? [])];
    const first = bodyCells[0];
    const second = bodyCells[1];

    expect(first.classList.contains('pinned')).toBe(true);
    expect(first.style.getPropertyValue('inset-inline-start')).toBe('0');
    expect(first.style.minWidth).toBe('12rem');
    expect(first.style.maxWidth).toBe('12rem');
    expect(second.style.getPropertyValue('inset-inline-start')).toBe('12rem');
    expect(second.classList.contains('pinned-last')).toBe(true);
    expect(bodyCells[2].classList.contains('pinned')).toBe(false);
  });

  it('auto-pins the select cell and accumulates calc() offsets across three slots', async () => {
    const el = twoPinned();

    el.selectable = true;
    await el.updateComplete;

    const selectCell = requiredElement<HTMLElement>(el.shadowRoot, '[part~="select-cell"]');

    expect(selectCell.classList.contains('pinned')).toBe(true);
    expect(selectCell.style.getPropertyValue('inset-inline-start')).toBe('0');

    const dataCells = [
      ...(el.shadowRoot?.querySelectorAll<HTMLElement>('[part="row"] [part~="cell"]:not([part~="select-cell"])') ?? []),
    ];

    expect(dataCells[0].style.getPropertyValue('inset-inline-start')).toBe('2.5rem');
    expect(dataCells[1].style.getPropertyValue('inset-inline-start')).toBe('calc(2.5rem + 12rem)');
  });

  it('keeps a data column with the OLD synthetic key id (__select) distinct from the reserved pin key', async () => {
    const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<{id: string; sel: string}>;

    el.columns = [
      column<{id: string; sel: string}>()({id: '__select', label: 'Sel', accessor: (row) => row.sel, sticky: 'start',
        width: '9rem'}),
    ] as never;
    el.rows = [{id: 'a', sel: 'v'}] as never;
    el.rowKey = 'id';
    el.selectable = true;
    el.columnMenu = false;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.hasAttribute('data-mndw-sticky-inactive')).toBe(false);

    const selectCell = requiredElement<HTMLElement>(el.shadowRoot, '[part~="select-cell"]');
    const dataCol = requiredElement<HTMLElement>(
      el.shadowRoot,
      '[part="row"] [part~="cell"]:not([part~="select-cell"])',
    );

    expect(selectCell.style.getPropertyValue('inset-inline-start')).toBe('0');
    expect(dataCol.style.getPropertyValue('inset-inline-start')).toBe('2.5rem');
  });

  it('clamps the reorderable drag cell to a fixed width when pinning is active', async () => {
    const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<Row>;

    el.columns = [
      column<Row>()({id: 'name', label: 'Name', accessor: (row: Row) => row.name, sticky: 'start', width: '12rem'}),
      column<Row>()({id: 'x', label: 'X', accessor: (row: Row) => row.name}),
    ] as never;
    el.rows = [{id: 'a', name: 'Alpha'}];
    el.rowKey = 'id';
    el.reorderable = true;
    el.columnMenu = false;
    document.body.appendChild(el);
    await el.updateComplete;

    const dragHandle = requiredElement<HTMLElement>(el.shadowRoot, '[part="drag-handle"]');
    const dragCell = dragHandle.closest<HTMLElement>('[part~="cell"]');

    if (dragCell === null) {
      throw new Error('missing drag cell');
    }

    expect(dragCell.classList.contains('pinned')).toBe(true);
    expect(dragCell.style.getPropertyValue('inset-inline-start')).toBe('0');
    expect(dragCell.style.width).toBe('2.5rem');
    expect(dragCell.style.maxWidth).toBe('2.5rem');
  });
});

describe('MndwTable sticky header', () => {
  it('reflects sticky-header and renders a pinned header cell', async () => {
    const el = makeTable();

    el.columns = [
      column<Row>()({id: 'name', label: 'Name', accessor: (row: Row) => row.name, sticky: 'start', width: '12rem'}),
      column<Row>()({id: 'x', label: 'X', accessor: (row: Row) => row.name}),
    ] as never;
    el.stickyHeader = true;
    el.columnMenu = false;
    await el.updateComplete;
    expect(el.hasAttribute('sticky-header')).toBe(true);
    expect(el.shadowRoot?.querySelector('[part~="header-cell"].pinned')).not.toBeNull();
  });

  it('compiles sticky-header rules, z-index ladder, hover-over-pinned, and logical separator rules', () => {
    const css = styleText();

    expect(hasRule(css, ':host([sticky-header]) [part~=\'header-cell\']', 'position: sticky', 'top: 0')).toBe(true);
    expect(hasRule(css, ':host([sticky-header]) [part~=\'header-cell\'].pinned', 'z-index: 3')).toBe(true);
    expect(hasRule(css, '.pinned', 'position: sticky', 'z-index: 1')).toBe(true);
    expect(hasRule(css, '[part~=\'header-cell\'].pinned', 'z-index: 2')).toBe(true);
    expect(hasRule(css, '[part=\'row\']:hover [part~=\'cell\']', 'background: var(--mndw-surface-hover)')).toBe(true);
    expect(hasRule(css, '.pinned-last', 'border-inline-end: 1px solid var(--mndw-border)')).toBe(true);
  });
});
