import {describe, expect, it} from 'vitest';
import {
  ColumnVisibilityState,
  applyReorder,
  compareCellValues,
  effectiveSort,
  nextSortState,
  resolveCellValue,
  resolveRowKey,
  selectAllState,
  sortRows,
  toggleKey,
  toggleSelectAll,
  validateColumns,
  validateRows,
} from './table-state.js';
import type {Column, RowKey, SortState} from './table-types.js';

interface Row {
  id: string;
  name: string;
  count: number;
  flag: boolean;
  nested: {title: string};
  maybe?: string | null;
}

function makeColumn<R>(def: {id: string; label: string; [key: string]: unknown}): Column<R> {
  return def as Column<R>;
}

describe('resolveRowKey', () => {
  it('resolves a string field', () => {
    expect(resolveRowKey('id', {id: 'a1'})).toBe('a1');
  });

  it('resolves a function form', () => {
    const key = (row: {proto: string; port: number}) => `${row.proto}:${row.port}`;

    expect(resolveRowKey(key, {proto: 'udp', port: 53})).toBe('udp:53');
  });

  it('returns empty string for a non-string field value', () => {
    const key = 'count' as unknown as RowKey<{id: string; count: number}>;

    expect(resolveRowKey(key, {id: 'a', count: 3})).toBe('');
  });
});

describe('validateRows', () => {
  const rows = (): Row[] => [
    {id: 'a', name: 'A', count: 1, flag: false, nested: {title: 'a'}},
    {id: 'b', name: 'B', count: 2, flag: true, nested: {title: 'b'}},
    {id: 'a', name: 'A2', count: 3, flag: false, nested: {title: 'a2'}},
    {id: '', name: 'Empty', count: 0, flag: false, nested: {title: 'e'}},
  ];

  it('drops empty and duplicate keys while keeping the first occurrence', () => {
    const {rows: valid, violations} = validateRows(rows(), 'id');

    expect(valid.map((row) => row.id)).toEqual(['a', 'b']);
    expect(violations).toEqual([
      {category: 'duplicate-row-key', rowKeys: ['a']},
      {category: 'empty-row-key', count: 1},
    ]);
  });

  it('reports no violations for a valid set', () => {
    const {rows: valid, violations} = validateRows(rows().slice(0, 2), 'id');

    expect(valid).toHaveLength(2);
    expect(violations).toEqual([]);
  });

  it('treats colon-containing keys as opaque and distinct', () => {
    const input = [
      {id: 'a:b', name: 'x', count: 0, flag: false, nested: {title: 'x'}},
      {id: 'a/b', name: 'y', count: 0, flag: false, nested: {title: 'y'}},
    ];

    expect(validateRows(input, 'id').rows).toHaveLength(2);
  });
});

describe('validateColumns', () => {
  it('reports duplicate column ids', () => {
    const cols = [
      makeColumn<Row>({id: 'name', label: 'Name'}),
      makeColumn<Row>({id: 'count', label: 'Count'}),
      makeColumn<Row>({id: 'name', label: 'Name2'}),
    ];

    expect(validateColumns(cols)).toEqual([{category: 'duplicate-column-id', columnIds: ['name']}]);
  });

  it('returns no violations when unique', () => {
    const cols = [makeColumn<Row>({id: 'name', label: 'Name'})];

    expect(validateColumns(cols)).toEqual([]);
  });

  it('reports reserved synthetic column ids', () => {
    const cols = [makeColumn<Row>({id: '__mndw_detail__', label: 'Detail'})];

    expect(validateColumns(cols)).toEqual([
      {category: 'reserved-column-id', columnIds: ['__mndw_detail__']},
    ]);
  });
});

describe('resolveCellValue', () => {
  it('reads a function accessor', () => {
    const col = makeColumn<Row>({id: 'title', label: 'Title', accessor: (row: Row) => row.nested.title});

    expect(resolveCellValue(col, {id: 'a', name: 'A', count: 1, flag: false, nested: {title: 'T'}})).toBe('T');
  });

  it('reads a keyof accessor', () => {
    const col = makeColumn<Row>({id: 'x', label: 'X', accessor: 'name'});

    expect(resolveCellValue(col, {id: 'a', name: 'A', count: 1, flag: false, nested: {title: 'T'}})).toBe('A');
  });

  it('defaults to row[id] when accessor is omitted', () => {
    const col = makeColumn<Row>({id: 'name', label: 'Name'});

    expect(resolveCellValue(col, {id: 'a', name: 'A', count: 1, flag: false, nested: {title: 'T'}})).toBe('A');
  });
});

describe('effectiveSort', () => {
  const cols = [
    makeColumn<Row>({id: 'name', label: 'Name', sortable: true}),
    makeColumn<Row>({id: 'count', label: 'Count'}),
  ];

  it('accepts a valid sortable, visible column', () => {
    expect(effectiveSort(cols, {columnId: 'name', direction: 'asc'}, new Set())).toEqual({
      columnId: 'name',
      direction: 'asc',
    });
  });

  it('rejects an unknown columnId', () => {
    expect(effectiveSort(cols, {columnId: 'nope', direction: 'asc'}, new Set())).toBeNull();
  });

  it('rejects a non-sortable column', () => {
    expect(effectiveSort(cols, {columnId: 'count', direction: 'asc'}, new Set())).toBeNull();
  });

  it('rejects a hidden column without mutating the controlled prop', () => {
    const sort: SortState = {columnId: 'name', direction: 'asc'};

    expect(effectiveSort(cols, sort, new Set(['name']))).toBeNull();
    expect(sort).toEqual({columnId: 'name', direction: 'asc'});
  });
});

describe('nextSortState', () => {
  it('cycles unsorted -> asc -> desc -> unsorted', () => {
    expect(nextSortState(null, 'name')).toEqual({columnId: 'name', direction: 'asc'});
    expect(nextSortState({columnId: 'name', direction: 'asc'}, 'name')).toEqual({
      columnId: 'name',
      direction: 'desc',
    });
    expect(nextSortState({columnId: 'name', direction: 'desc'}, 'name')).toBeNull();
  });

  it('switches to a new column as ascending', () => {
    expect(nextSortState({columnId: 'name', direction: 'desc'}, 'count')).toEqual({
      columnId: 'count',
      direction: 'asc',
    });
  });
});

describe('sortRows', () => {
  const makeRows = (): Row[] => [
    {id: '1', name: 'cherry', count: 10, flag: true, nested: {title: 'c'}},
    {id: '2', name: 'apple', count: 3, flag: false, nested: {title: 'a'}},
    {id: '3', name: 'Banana', count: 7, flag: true, nested: {title: 'b'}},
    {id: '4', name: 'apple', count: 9, flag: false, nested: {title: 'a2'}},
  ];

  it('sorts text case-insensitively with case tiebreak', () => {
    const col = makeColumn<Row>({id: 'name', label: 'Name', sortable: true, accessor: 'name'});

    expect(sortRows(makeRows(), [col], {columnId: 'name', direction: 'asc'}).map((r) => r.name)).toEqual([
      'apple',
      'apple',
      'Banana',
      'cherry',
    ]);
  });

  it('keeps stable order for equal keys', () => {
    const col = makeColumn<Row>({id: 'name', label: 'Name', sortable: true, accessor: 'name'});
    const sorted = sortRows(makeRows(), [col], {columnId: 'name', direction: 'asc'});

    expect(sorted.filter((r) => r.name === 'apple').map((r) => r.id)).toEqual(['2', '4']);
  });

  it('sorts numbers numerically', () => {
    const col = makeColumn<Row>({id: 'count', label: 'Count', sortable: true, kind: 'number', accessor: 'count'});

    expect(sortRows(makeRows(), [col], {columnId: 'count', direction: 'asc'}).map((r) => r.count)).toEqual([
      3,
      7,
      9,
      10,
    ]);
  });

  it('honours a custom comparator over the accessor value', () => {
    const col = makeColumn<Row>({
      id: 'nested',
      label: 'Nested',
      sortable: true,
      accessor: (row: Row) => row.nested.title,
      comparator: (a: string, b: string) => b.localeCompare(a),
    });

    expect(sortRows(makeRows(), [col], {columnId: 'nested', direction: 'asc'}).map((r) => r.nested.title)).toEqual([
      'c',
      'b',
      'a2',
      'a',
    ]);
  });

  it('sorts nulls and NaN last in both directions', () => {
    const rows: Row[] = [
      {id: '1', name: 'b', count: 1, flag: false, nested: {title: ''}, maybe: 'b'},
      {id: '2', name: 'a', count: NaN, flag: false, nested: {title: ''}, maybe: null},
      {id: '3', name: 'c', count: 5, flag: false, nested: {title: ''}, maybe: 'c'},
      {id: '4', name: 'd', count: 2, flag: false, nested: {title: ''}, maybe: undefined},
    ];
    const col = makeColumn<Row>({id: 'count', label: 'Count', sortable: true, kind: 'number', accessor: 'count'});

    expect(sortRows(rows, [col], {columnId: 'count', direction: 'asc'}).map((r) => r.count)).toEqual([1, 2, 5, NaN]);
    expect(sortRows(rows, [col], {columnId: 'count', direction: 'desc'}).map((r) => r.count)).toEqual([5, 2, 1, NaN]);
  });

  it('returns input order for an unknown or non-sortable columnId', () => {
    const col = makeColumn<Row>({id: 'name', label: 'Name', sortable: true, accessor: 'name'});

    expect(sortRows(makeRows(), [col], {columnId: 'nope', direction: 'asc'})).toEqual(makeRows());
  });
});

describe('compareCellValues', () => {
  it('orders booleans numerically', () => {
    const col = makeColumn<Row>({id: 'flag', label: 'Flag', kind: 'boolean'});

    expect(compareCellValues(col, false, true)).toBeLessThan(0);
  });
});

describe('selection', () => {
  it('computes all/none/indeterminate over the logical row set', () => {
    expect(selectAllState(new Set(['a', 'b']), ['a', 'b'])).toBe('all');
    expect(selectAllState(new Set(), ['a', 'b'])).toBe('none');
    expect(selectAllState(new Set(['a']), ['a', 'b'])).toBe('indeterminate');
    expect(selectAllState(new Set(['a']), [])).toBe('none');
  });

  it('toggles a single key and preserves absent keys', () => {
    expect(toggleKey(['a', 'gone'], 'b')).toEqual(['a', 'gone', 'b']);
    expect(toggleKey(['a', 'gone'], 'a')).toEqual(['gone']);
  });

  it('select-all adds the logical set and deselects when all are selected', () => {
    expect(toggleSelectAll(['gone'], ['a', 'b'])).toEqual(['gone', 'a', 'b']);
    expect(toggleSelectAll(['a', 'b', 'gone'], ['a', 'b'])).toEqual(['gone']);
  });
});

describe('reorder', () => {
  const rows = [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}];
  const resolve = (row: {id: string}) => row.id;

  it('moves a row before another', () => {
    expect(applyReorder(rows, resolve, {key: 'd', beforeKey: 'a'}).map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('moves a row to the end when beforeKey is null', () => {
    expect(applyReorder(rows, resolve, {key: 'a', beforeKey: null}).map((r) => r.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('leaves order unchanged for an unknown key', () => {
    expect(applyReorder(rows, resolve, {key: 'nope', beforeKey: 'a'})).toEqual(rows);
  });
});

describe('ColumnVisibilityState', () => {
  const cols = [
    makeColumn<Row>({id: 'name', label: 'Name', hideable: false}),
    makeColumn<Row>({id: 'ip', label: 'IP'}),
    makeColumn<Row>({id: 'mac', label: 'MAC', hidden: true}),
  ];

  it('seeds internalHidden from column.hidden when uncontrolled', () => {
    const state = new ColumnVisibilityState();

    expect([...state.effectiveHidden(cols, undefined)]).toEqual(['mac']);
  });

  it('locks hideable: false columns visible even when present in a set', () => {
    const state = new ColumnVisibilityState();

    expect([...state.effectiveHidden(cols, ['name', 'ip'])]).toEqual(['ip']);
  });

  it('governs a column first seen while controlled by hiddenColumns', () => {
    const state = new ColumnVisibilityState();
    const controlledCols = [makeColumn<Row>({id: 'fresh', label: 'Fresh'})];

    expect([...state.effectiveHidden(controlledCols, ['fresh'])]).toEqual(['fresh']);
    expect([...state.effectiveHidden(controlledCols, [])]).toEqual([]);
  });

  it('carries the last effective set across a controlled -> uncontrolled transition', () => {
    const state = new ColumnVisibilityState();

    state.effectiveHidden(cols, ['ip']);
    state.effectiveHidden(cols, ['ip', 'mac']);

    expect([...state.effectiveHidden(cols, undefined)]).toEqual(['ip', 'mac']);
  });

  it('shadows internalHidden when switching uncontrolled -> controlled', () => {
    const state = new ColumnVisibilityState();

    state.effectiveHidden(cols, undefined);

    expect([...state.effectiveHidden(cols, ['ip'])]).toEqual(['ip']);
  });

  it('emits a user-intent toggle list in both modes', () => {
    const state = new ColumnVisibilityState();

    expect(state.toggle(cols, ['ip'], 'mac')).toEqual(['ip', 'mac']);

    const uncontrolled = new ColumnVisibilityState();

    expect(uncontrolled.toggle(cols, undefined, 'ip')).toEqual(['mac', 'ip']);
  });
});
