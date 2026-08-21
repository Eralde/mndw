export type CellKind = 'text' | 'number' | 'badge' | 'boolean';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export type CellAlign = 'start' | 'end' | 'center';

export interface Column<Row, Value = unknown> {
  id: string;
  label: string;
  accessor?: keyof Row | ((row: Row) => Value);
  kind?: CellKind;
  sortable?: boolean;
  hidden?: boolean;
  hideable?: boolean;
  align?: CellAlign;
  width?: string;
  renderer?: () => CellRenderer<Row, Value>;
  badge?: (value: Value, row: Row) => {text: string; tone: BadgeTone};
  comparator?: (a: Value, b: Value) => number;
}

export type ColumnDef<Row, Value> = Column<Row, Value>;

export interface CellContext<Row, Value = unknown> {
  node: HTMLElement;
  row: Row;
  value: Value;
  colId: string;
}

export interface CellRenderer<Row = unknown, Value = unknown> {
  mount: (ctx: CellContext<Row, Value>) => void;
  update: (ctx: CellContext<Row, Value>) => void;
  destroy: () => void;
}

export interface CellProps<Row, Value> {
  row: Row;
  value: Value;
  colId: string;
}

export type StringKeyOf<Row> = { [K in keyof Row]-?: Row[K] extends string ? K : never }[keyof Row] & string;

export type RowKey<Row> = StringKeyOf<Row> | ((row: Row) => string);

export interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface MndwTableLabels {
  selectRow: (rowName: string) => string;
  selectAll: string;
  sortBy: (columnLabel: string) => string;
  columnMenu: string;
  rowFallback: (index1Based: number) => string;
  reordered: (rowName: string, pos: number, total: number) => string;
  invalidData: string;
  expandRow: (rowName: string) => string;
  collapseRow: (rowName: string) => string;
}

export interface MndwTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: RowKey<Row>;
  virtual?: boolean;
  estimatedRowHeight?: number;
  overscan?: number;
  selectable?: boolean;
  selected?: string[];
  reorderable?: boolean;
  sort?: SortState | null;
  sortMode?: 'client' | 'manual';
  hiddenColumns?: string[];
  columnMenu?: boolean;
  columnMenuPanelClass?: string;
  caption?: string;
  rowLabel?: (row: Row) => string;
  labels?: Partial<MndwTableLabels>;
  emptyLabel?: string;
  expandable?: boolean;
  expandOn?: 'toggle' | 'row';
  toggleCell?: 'leading' | 'trailing';
  toggleAfterColumn?: string;
  expanded?: string[];
  expandedRenderer?: () => CellRenderer<Row, Row>;
}

export interface ScrollToRowOptions {
  align?: 'start' | 'center' | 'end' | 'nearest';
}

export type Violation =
  | {category: 'duplicate-row-key'; rowKeys: string[]}
  | {category: 'empty-row-key'; count: number}
  | {category: 'duplicate-column-id'; columnIds: string[]}
  | {category: 'reserved-column-id'; columnIds: string[]};

export interface MndwErrorDetail {
  violations: Violation[];
}

export interface MndwSelectionChangeDetail {
  selected: string[];
}

export interface MndwSortChangeDetail {
  sort: SortState | null;
}

export interface MndwRowReorderDetail {
  key: string;
  beforeKey: string | null;
}

export interface MndwColumnVisibilityChangeDetail {
  hidden: string[];
}

export const MNDW_SELECTION_CHANGE_EVENT = 'mndwselectionchange';
export const MNDW_SORT_CHANGE_EVENT = 'mndwsortchange';
export const MNDW_ROW_REORDER_EVENT = 'mndwrowreorder';
export const MNDW_COLUMN_VISIBILITY_CHANGE_EVENT = 'mndwcolumnvisibilitychange';
export const MNDW_ERROR_EVENT = 'mndwerror';

export interface MndwRowExpandDetail {
  expanded: string[];
}

export const MNDW_ROW_EXPAND_EVENT = 'mndwrowexpand';
export const DETAIL_COL_ID = '__mndw_detail__';
