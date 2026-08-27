import {afterEach, describe, expect, it} from 'vitest';
import {MNDW_CHECKBOX_TAG, MndwCheckbox} from '../checkbox/checkbox.js';
import {MNDW_COLUMN_MENU_TAG, MndwColumnMenu} from './column-menu.js';
import {defineComponents} from '../testing/index.js';
import {column} from './table-builder.js';
import {MNDW_TABLE_TAG, MndwTable} from './table.js';

interface Row {
  id: string;
  a: string;
  b: string;
}

defineComponents(
  [MNDW_TABLE_TAG, MndwTable],
  [MNDW_CHECKBOX_TAG, MndwCheckbox],
  [MNDW_COLUMN_MENU_TAG, MndwColumnMenu],
);

afterEach(() => {
  document.body.innerHTML = '';
});

const cssHas = (selector: string, ...declarations: string[]): boolean => {
  const flat = String((MndwTable as unknown as {styles: unknown}).styles).replace(/\s+/g, ' ');
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = flat.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));

  return match !== null && declarations.every((declaration) => match[1].includes(declaration.replace(/\s+/g, ' ')));
};

describe('MndwTable nowrap', () => {
  it('compiles the nowrap rule', () => {
    expect(cssHas('.nowrap', 'white-space: nowrap')).toBe(true);
  });

  it('marks only the nowrap column header and body cells', async () => {
    const el = document.createElement(MNDW_TABLE_TAG) as MndwTable<Row>;

    el.columns = [
      column<Row>()({id: 'a', label: 'A', accessor: (row: Row) => row.a, nowrap: true}),
      column<Row>()({id: 'b', label: 'B', accessor: (row: Row) => row.b}),
    ];
    el.rows = [{id: 'r', a: 'x', b: 'y'}];
    el.rowKey = 'id';
    el.columnMenu = false;
    document.body.appendChild(el);
    await el.updateComplete;

    const headers = [...(el.shadowRoot?.querySelectorAll('[part~="header-cell"]') ?? [])] as HTMLElement[];
    const cells = [...(el.shadowRoot?.querySelectorAll('[part="row"] [part~="cell"]') ?? [])] as HTMLElement[];

    expect(headers[0].classList.contains('nowrap')).toBe(true);
    expect(headers[1].classList.contains('nowrap')).toBe(false);
    expect(cells[0].classList.contains('nowrap')).toBe(true);
    expect(cells[1].classList.contains('nowrap')).toBe(false);
  });
});
