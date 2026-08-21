import type {Column, RowKey, SortState, Violation} from './table-types.js';

export interface RowValidation<Row> {
  rows: Row[];
  violations: Violation[];
}

export type SelectAllState = 'all' | 'none' | 'indeterminate';

export interface ReorderIntent {
  key: string;
  beforeKey: string | null;
}

export function resolveRowKey<Row>(rowKey: RowKey<Row>, row: Row): string {
  if (typeof rowKey === 'function') {
    return rowKey(row);
  }

  const value = row[rowKey] as unknown;

  return typeof value === 'string' ? value : '';
}

export function validateRows<Row>(rows: Row[], rowKey: RowKey<Row>): RowValidation<Row> {
  const valid: Row[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let emptyCount = 0;

  for (const row of rows) {
    const key = resolveRowKey(rowKey, row);

    if (key === '') {
      emptyCount++;

      continue;
    }

    if (seen.has(key)) {
      duplicates.add(key);

      continue;
    }

    seen.add(key);
    valid.push(row);
  }

  const violations: Violation[] = [];

  if (duplicates.size > 0) {
    violations.push({category: 'duplicate-row-key', rowKeys: [...duplicates]});
  }

  if (emptyCount > 0) {
    violations.push({category: 'empty-row-key', count: emptyCount});
  }

  return {rows: valid, violations};
}

export function validateColumns<Row>(columns: Column<Row>[]): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const column of columns) {
    if (seen.has(column.id)) {
      duplicates.add(column.id);
    }

    seen.add(column.id);
  }

  if (duplicates.size > 0) {
    violations.push({category: 'duplicate-column-id', columnIds: [...duplicates]});
  }

  const reserved = columns.map((column) => column.id).filter((id) => id.startsWith('__mndw_'));

  if (reserved.length > 0) {
    violations.push({category: 'reserved-column-id', columnIds: reserved});
  }

  return violations;
}

export function getColumn<Row>(columns: Column<Row>[], id: string): Column<Row> | undefined {
  return columns.find((column) => column.id === id);
}

export function resolveCellValue<Row>(column: Column<Row>, row: Row): unknown {
  const accessor = column.accessor;

  if (accessor === undefined) {
    return (row as Record<string, unknown>)[column.id];
  }

  if (typeof accessor === 'function') {
    return accessor(row);
  }

  return (row as Record<string, unknown>)[accessor as string];
}

export function effectiveSort<Row>(
  columns: Column<Row>[],
  sort: SortState | null | undefined,
  hidden: ReadonlySet<string>,
): SortState | null {
  if (sort === null || sort === undefined) {
    return null;
  }

  const column = getColumn(columns, sort.columnId);

  if (column?.sortable !== true || hidden.has(sort.columnId)) {
    return null;
  }

  return sort;
}

export function nextSortState(current: SortState | null | undefined, columnId: string): SortState | null {
  if (current?.columnId !== columnId) {
    return {columnId, direction: 'asc'};
  }

  if (current.direction === 'asc') {
    return {columnId, direction: 'desc'};
  }

  return null;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value));
}

function compareText(a: string, b: string, locale: string): number {
  const primary = a.localeCompare(b, locale, {sensitivity: 'base'});

  if (primary !== 0) {
    return primary;
  }

  return a.localeCompare(b, locale, {sensitivity: 'case'});
}

export function compareCellValues<Row>(column: Column<Row>, a: unknown, b: unknown, locale = 'en'): number {
  if (column.comparator !== undefined) {
    return column.comparator(a as never, b as never);
  }

  if (column.kind === 'number' || column.kind === 'boolean') {
    return Number(a) - Number(b);
  }

  return compareText(String(a), String(b), locale);
}

export function sortRows<Row>(
  rows: Row[],
  columns: Column<Row>[],
  sort: SortState | null | undefined,
  locale = 'en',
): Row[] {
  if (sort === null || sort === undefined) {
    return rows;
  }

  const column = getColumn(columns, sort.columnId);

  if (column?.sortable !== true) {
    return rows;
  }

  const direction = sort.direction === 'desc' ? -1 : 1;
  const indexed = rows.map((row, index) => ({row, index, value: resolveCellValue(column, row)}));

  indexed.sort((a, b) => {
    const aNull = isNullish(a.value);
    const bNull = isNullish(b.value);

    if (aNull && bNull) {
      return a.index - b.index;
    }

    if (aNull) {
      return 1;
    }

    if (bNull) {
      return -1;
    }

    const compared = compareCellValues(column, a.value, b.value, locale);

    return compared !== 0 ? compared * direction : a.index - b.index;
  });

  return indexed.map((entry) => entry.row);
}

export function selectAllState(selected: ReadonlySet<string>, rowKeys: readonly string[]): SelectAllState {
  if (rowKeys.length === 0) {
    return 'none';
  }

  let selectedCount = 0;

  for (const key of rowKeys) {
    if (selected.has(key)) {
      selectedCount++;
    }
  }

  if (selectedCount === rowKeys.length) {
    return 'all';
  }

  if (selectedCount === 0) {
    return 'none';
  }

  return 'indeterminate';
}

export function toggleKey(selected: readonly string[], key: string): string[] {
  const next = new Set(selected);

  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }

  return [...next];
}

export function toggleSelectAll(selected: readonly string[], rowKeys: readonly string[]): string[] {
  const next = new Set(selected);
  const state = selectAllState(next, rowKeys);

  if (state === 'all') {
    for (const key of rowKeys) {
      next.delete(key);
    }
  } else {
    for (const key of rowKeys) {
      next.add(key);
    }
  }

  return [...next];
}

export function applyReorder<Row>(
  rows: Row[],
  resolve: (row: Row) => string,
  intent: ReorderIntent,
): Row[] {
  const sourceIndex = rows.findIndex((row) => resolve(row) === intent.key);

  if (sourceIndex === -1) {
    return rows;
  }

  const result = [...rows];
  const [moved] = result.splice(sourceIndex, 1);

  if (moved === undefined) {
    return rows;
  }

  const beforeIndex = intent.beforeKey === null
    ? result.length
    : result.findIndex((row) => resolve(row) === intent.beforeKey);

  if (beforeIndex === -1) {
    result.push(moved);
  } else {
    result.splice(beforeIndex, 0, moved);
  }

  return result;
}

function hideableIds<Row>(columns: Column<Row>[]): Set<string> {
  return new Set(columns.filter((column) => column.hideable !== false).map((column) => column.id));
}

export function toggleHidden(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);

  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  return next;
}

export class ColumnVisibilityState {
  private internalHidden = new Set<string>();
  private seededIds = new Set<string>();
  private lastEffective = new Set<string>();
  private wasControlled = false;

  public effectiveHidden<Row>(columns: Column<Row>[], controlled: string[] | undefined): Set<string> {
    this.seed(columns);

    const hideable = hideableIds(columns);

    if (controlled !== undefined) {
      const effective = new Set<string>();

      for (const id of controlled) {
        if (hideable.has(id)) {
          effective.add(id);
        }
      }

      this.lastEffective = new Set(effective);
      this.wasControlled = true;

      return effective;
    }

    if (this.wasControlled) {
      this.internalHidden = new Set(this.lastEffective);
      this.wasControlled = false;
    }

    const effective = new Set<string>();

    for (const id of this.internalHidden) {
      if (hideable.has(id)) {
        effective.add(id);
      }
    }

    return effective;
  }

  public toggle<Row>(columns: Column<Row>[], controlled: string[] | undefined, id: string): string[] {
    const effective = this.effectiveHidden(columns, controlled);
    const next = toggleHidden(effective, id);
    const hideable = hideableIds(columns);
    const filtered = [...next].filter((columnId) => hideable.has(columnId));

    if (controlled === undefined) {
      this.internalHidden = new Set(filtered);
    }

    return filtered;
  }

  public applyInternal(hidden: readonly string[]): void {
    this.internalHidden = new Set(hidden);
    this.wasControlled = false;
  }

  private seed<Row>(columns: Column<Row>[]): void {
    for (const column of columns) {
      if (!this.seededIds.has(column.id)) {
        this.seededIds.add(column.id);

        if (column.hidden === true) {
          this.internalHidden.add(column.id);
        }
      }
    }
  }
}
