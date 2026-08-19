import {LitElement, type PropertyDeclarations, css, html, nothing} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import {getMndwUiText, subscribeMndwUiLocale} from '../i18n.js';
import {type UiLayer, getOverlayProvider} from '../overlay.js';
import {focusRing, hostTypography} from '../styles/base.js';
import {CellRegistry} from './table-cells.js';
import {
  MNDW_COLUMN_MENU_CHECK_EVENT,
  MNDW_COLUMN_MENU_TAG,
  type MndwColumnMenuCheckDetail,
  type MndwColumnMenuOption,
  type MndwPanelDismissDetail,
} from './column-menu.js';
import {
  ColumnVisibilityState,
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
import {
  type BadgeTone,
  type Column,
  MNDW_COLUMN_VISIBILITY_CHANGE_EVENT,
  MNDW_ERROR_EVENT,
  MNDW_ROW_REORDER_EVENT,
  MNDW_SELECTION_CHANGE_EVENT,
  MNDW_SORT_CHANGE_EVENT,
  type MndwColumnVisibilityChangeDetail,
  type MndwErrorDetail,
  type MndwRowReorderDetail,
  type MndwSelectionChangeDetail,
  type MndwSortChangeDetail,
  type MndwTableLabels,
  type RowKey,
  type SortState,
  type Violation,
} from './table-types.js';

export const MNDW_TABLE_TAG = 'mndw-table';

const EVENT_OPTIONS = {bubbles: true, composed: true, cancelable: false};

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''));
}

function classAttr(list: string[]): string | typeof nothing {
  return list.length > 0 ? list.join(' ') : nothing;
}

function defaultLabels(): MndwTableLabels {
  return {
    selectRow: (rowName) => formatTemplate(getMndwUiText('table.selectRow'), {rowName}),
    selectAll: getMndwUiText('table.selectAll'),
    sortBy: (columnLabel) => formatTemplate(getMndwUiText('table.sortBy'), {column: columnLabel}),
    columnMenu: getMndwUiText('table.columnMenu'),
    rowFallback: (index1Based) => formatTemplate(getMndwUiText('table.rowFallback'), {index: index1Based}),
    reordered: (rowName, pos, total) => formatTemplate(getMndwUiText('table.reordered'), {rowName, pos, total}),
    invalidData: getMndwUiText('table.invalidData'),
  };
}

export class MndwTable<Row = unknown> extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    columns: {type: Array, attribute: false},
    rows: {type: Array, attribute: false},
    rowKey: {type: String, attribute: 'row-key'},
    selectable: {type: Boolean, reflect: true},
    selected: {type: Array, attribute: false},
    reorderable: {type: Boolean, reflect: true},
    sort: {type: Object, attribute: false},
    sortMode: {type: String, attribute: 'sort-mode'},
    hiddenColumns: {type: Array, attribute: false},
    columnMenu: {type: Boolean, attribute: false},
    columnMenuPanelClass: {type: String, attribute: 'column-menu-panel-class'},
    caption: {type: String},
    rowLabel: {type: Object, attribute: false},
    labels: {type: Object, attribute: false},
    emptyLabel: {type: String, attribute: 'empty-label'},
  };

  public static override readonly styles = css`
    :host {
      ${hostTypography}
      display: block;
      color: var(--mndw-text);
    }

    [part='viewport'] {
      overflow: auto;
      min-height: 0;
    }

    [part='table'] {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    [part='caption'] {
      text-align: start;
    }

    [part='header-cell'] {
      text-align: start;
      padding: var(--mndw-space-2);
      border-bottom: 1px solid var(--mndw-border);
      font-size: var(--mndw-text-sm);
      color: var(--mndw-text-muted);
    }

    [part='cell'] {
      padding: var(--mndw-space-2);
      border-bottom: 1px solid var(--mndw-border);
    }

    [part='row']:hover [part='cell'] {
      background: var(--mndw-surface-hover);
    }

    [part='sort-indicator'] {
      margin-inline-start: var(--mndw-space-1);
    }

    [part='drag-handle'] {
      cursor: grab;
    }

    [part='error'] {
      padding: var(--mndw-space-2);
      color: var(--mndw-danger);
      background: var(--mndw-danger-bg);
      border-radius: var(--mndw-radius-sm);
      margin-bottom: var(--mndw-space-2);
    }

    [part='empty'] {
      padding: var(--mndw-space-3);
      color: var(--mndw-text-muted);
      text-align: center;
    }

    [part='badge'] {
      display: inline-flex;
      align-items: center;
      gap: var(--mndw-space-1);
      padding: var(--mndw-space-1) var(--mndw-space-2);
      border-radius: var(--mndw-radius-sm);
      background: var(--mndw-surface-raised);
      color: var(--mndw-text);
      font-size: var(--mndw-text-sm);
    }

    [part='badge-dot'] {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .align-end {
      text-align: end;
    }

    .align-center {
      text-align: center;
    }

    .cell-kind-number {
      font-family: var(--mndw-font-mono);
    }

    .sort-button {
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
    }

    .sort-button:focus-visible,
    [part='drag-handle']:focus-visible,
    [part='column-menu-trigger']:focus-visible {
      ${focusRing}
    }
  `;

  declare public columns: Column<Row>[];
  declare public rows: Row[];
  declare public rowKey: RowKey<Row>;
  declare public selectable: boolean;
  declare public selected: string[];
  declare public reorderable: boolean;
  declare public sort: SortState | null;
  declare public sortMode: 'client' | 'manual';
  declare public hiddenColumns: string[] | undefined;
  declare public columnMenu: boolean;
  declare public columnMenuPanelClass: string;
  declare public caption: string;
  declare public rowLabel: ((row: Row) => string) | undefined;
  declare public labels: Partial<MndwTableLabels> | undefined;
  declare public emptyLabel: string;

  private readonly visibilityState = new ColumnVisibilityState();
  private cellRegistry: CellRegistry<Row> | null = null;
  private localeUnsubscribe: (() => void) | null = null;
  private menuLayer: UiLayer | null = null;

  private effectiveColumns: Column<Row>[] = [];
  private displayRows: Row[] = [];
  private effectiveHidden = new Set<string>();
  private effectiveSortState: SortState | null = null;
  private violations: Violation[] = [];
  private lastViolationSignature = '';
  private optimisticOrder: Row[] | null = null;
  private dragKey: string | null = null;
  private announceText = '';

  constructor() {
    super();
    this.columns = [];
    this.rows = [];
    this.rowKey = 'id' as RowKey<Row>;
    this.selectable = false;
    this.selected = [];
    this.reorderable = false;
    this.sort = null;
    this.sortMode = 'client';
    this.hiddenColumns = undefined;
    this.columnMenu = true;
    this.columnMenuPanelClass = '';
    this.caption = '';
    this.rowLabel = undefined;
    this.labels = undefined;
    this.emptyLabel = '';

    this.addEventListener('mndwchange', this.handleCheckboxChange);
    this.addEventListener('click', this.handleClick);
    this.addEventListener('keydown', this.handleKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.cellRegistry = new CellRegistry<Row>(this);
    this.localeUnsubscribe = subscribeMndwUiLocale(this.onLocaleChange);
  }

  public override disconnectedCallback(): void {
    this.localeUnsubscribe?.();
    this.localeUnsubscribe = null;
    this.closeColumnMenu();
    this.cellRegistry?.drain();
    this.cellRegistry = null;
    super.disconnectedCallback();
  }

  public override willUpdate(_changedProperties: Map<string | number | symbol, unknown>): void {
    this.reconcileState();
  }

  private reconcileState(): void {
    const columnViolations = validateColumns(this.columns);
    const {rows: validRows, violations: rowViolations} = validateRows(this.rows, this.rowKey);

    this.violations = [...columnViolations, ...rowViolations];
    this.emitErrorIfChanged();

    this.effectiveColumns = this.columns.filter((column, index, all) => {
      return all.findIndex((candidate) => candidate.id === column.id) === index;
    });

    this.effectiveHidden = this.visibilityState.effectiveHidden(this.effectiveColumns, this.hiddenColumns);
    this.effectiveSortState = effectiveSort(this.effectiveColumns, this.sort, this.effectiveHidden);

    const visibleColumnIds = new Set(
      this.effectiveColumns.filter((column) => !this.effectiveHidden.has(column.id)).map((column) => column.id),
    );

    if (this.optimisticOrder !== null) {
      this.displayRows = this.optimisticOrder;
    } else if (this.sortMode === 'client' && this.effectiveSortState !== null) {
      this.displayRows = sortRows(validRows, this.effectiveColumns, this.effectiveSortState, this.locale());
    } else {
      this.displayRows = validRows;
    }

    this.cellRegistry?.reconcile(
      this.displayRows,
      (row) => resolveRowKey(this.rowKey, row),
      this.effectiveColumns,
      visibleColumnIds,
      resolveCellValue,
    );
  }

  protected override render(): unknown {
    const labels = this.resolveLabels();
    const showEmpty = this.displayRows.length === 0 && this.emptyLabel;

    return html`
      ${this.violations.length > 0 ? html`<div part="error" role="alert">${labels.invalidData}</div>` : nothing}
      ${
      showEmpty
        ? html`<div part="empty">${this.emptyLabel}</div>`
        : html`
          <div part="viewport">
            <table part="table">
              ${this.caption ? html`<caption part="caption">${this.caption}</caption>` : nothing}
              ${this.renderHeader(labels)}
              <tbody>
                ${
          repeat(
            this.displayRows,
            (row) => resolveRowKey(this.rowKey, row),
            (row, index) => this.renderRow(row, index, labels),
          )
        }
              </tbody>
            </table>
          </div>`
    }
      <div part="live-region" aria-live="polite">${this.announceText}</div>
    `;
  }

  private renderHeader(labels: MndwTableLabels): unknown {
    return html`
      <thead part="header">
        <tr part="header-row">
          ${
      this.selectable
        ? html`<th part="header-cell select-cell" scope="col">
              ${
          this.renderCheckbox({
            ariaLabel: labels.selectAll,
            checked: this.isAllSelected(),
            indeterminate: this.isIndeterminate(),
            selectAll: true,
          })
        }
            </th>`
        : nothing
    }
          ${this.reorderable ? html`<th part="header-cell" scope="col"></th>` : nothing}
          ${
      this.effectiveColumns
        .filter((column) => !this.effectiveHidden.has(column.id))
        .map((column) => this.renderHeaderCell(column, labels))
    }
          ${
      this.columnMenu
        ? html`<th part="header-cell" scope="col" class="align-end">
              <button
                part="column-menu-trigger"
                class="sort-button"
                type="button"
                aria-label=${labels.columnMenu}
              >⚙</button>
            </th>`
        : nothing
    }
        </tr>
      </thead>
    `;
  }

  private renderHeaderCell(column: Column<Row>, labels: MndwTableLabels): unknown {
    const align = classAttr(this.alignClassList(column));

    if (column.sortable !== true) {
      return html`<th part="header-cell" scope="col" class=${align}>${column.label}</th>`;
    }

    const direction = this.effectiveSortState?.columnId === column.id ? this.effectiveSortState?.direction : undefined;
    const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : nothing;
    const indicator = direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : '';

    return html`
      <th part="header-cell" scope="col" class=${align} aria-sort=${ariaSort}>
        <button
          class="sort-button"
          type="button"
          data-sort-column=${column.id}
          aria-label=${labels.sortBy(column.label)}
        >${column.label}<span part="sort-indicator">${indicator}</span></button>
      </th>
    `;
  }

  private renderRow(row: Row, index: number, labels: MndwTableLabels): unknown {
    const key = resolveRowKey(this.rowKey, row);

    return html`
      <tr part="row">
        ${
      this.selectable
        ? html`<td part="select-cell cell">
            ${
          this.renderCheckbox({
            ariaLabel: labels.selectRow(this.rowName(row, index)),
            checked: this.selected.includes(key),
            indeterminate: false,
            rowKey: key,
          })
        }
          </td>`
        : nothing
    }
        ${
      this.reorderable && this.effectiveSortState === null
        ? html`<td part="cell">
            <button
              part="drag-handle"
              type="button"
              data-row-key=${key}
              aria-label=${labels.selectRow(this.rowName(row, index))}
            >⠿</button>
          </td>`
        : nothing
    }
        ${
      this.effectiveColumns
        .filter((column) => !this.effectiveHidden.has(column.id))
        .map((column) => this.renderCell(column, row))
    }
        ${this.columnMenu ? html`<td part="cell"></td>` : nothing}
      </tr>
    `;
  }

  private renderCell(column: Column<Row>, row: Row): unknown {
    const align = this.alignClassList(column);
    const slotId = column.renderer !== undefined
      ? this.cellRegistry?.getSlotId(resolveRowKey(this.rowKey, row), column.id)
      : undefined;

    // Custom-renderer cells: align classes only, NO cell-kind-number (matches the old build order).
    if (slotId !== undefined) {
      return html`<td part="cell" class=${classAttr(align)}><slot name=${slotId}></slot></td>`;
    }

    const classes = column.kind === 'number' ? [...align, 'cell-kind-number'] : align;
    const value = resolveCellValue(column, row);

    return html`<td part="cell" class=${classAttr(classes)}>${this.renderBuiltIn(column, value, row)}</td>`;
  }

  private renderBuiltIn(column: Column<Row>, value: unknown, row: Row): unknown {
    if (column.kind === 'badge') {
      const badge = column.badge?.(value as never, row);

      // undefined badge -> empty cell (the old empty Text node is intentionally dropped; both ''
      // and nothing render no node in a Lit child expression).
      if (badge === undefined) {
        return nothing;
      }

      return html`<span part="badge"
        ><span part="badge-dot" style="background: ${this.toneColor(badge.tone)};"></span>${badge.text}</span>`;
    }

    if (column.kind === 'boolean') {
      return value ? '✓' : '—';
    }

    return value === null || value === undefined ? '' : String(value as string | number);
  }

  private renderCheckbox(options: {
    ariaLabel: string;
    checked: boolean;
    indeterminate: boolean;
    rowKey?: string;
    selectAll?: boolean;
  }): unknown {
    return html`<mndw-checkbox
      aria-label=${options.ariaLabel}
      part=${options.selectAll ? 'select-all' : nothing}
      ?data-select-all=${options.selectAll ?? false}
      data-row-key=${options.rowKey ?? nothing}
      .checked=${options.checked}
      .indeterminate=${options.indeterminate}
    ></mndw-checkbox>`;
  }

  private alignClassList(column: Column<Row>): string[] {
    const classes: string[] = [];

    if (column.align === 'end') {
      classes.push('align-end');
    }

    if (column.align === 'center') {
      classes.push('align-center');
    }

    return classes;
  }

  private toneColor(tone: BadgeTone): string {
    return `var(--mndw-${tone === 'neutral' ? 'text-muted' : tone})`;
  }

  private resolveLabels(): MndwTableLabels {
    return {...defaultLabels(), ...this.labels};
  }

  private rowName(row: Row, index: number): string {
    return this.rowLabel?.(row) ?? this.resolveLabels().rowFallback(index + 1);
  }

  private locale(): string {
    return document.documentElement.lang || 'en';
  }

  private isAllSelected(): boolean {
    return selectAllState(new Set(this.selected), this.displayRows.map((row) => resolveRowKey(this.rowKey, row)))
      === 'all';
  }

  private isIndeterminate(): boolean {
    return selectAllState(new Set(this.selected), this.displayRows.map((row) => resolveRowKey(this.rowKey, row)))
      === 'indeterminate';
  }

  private emitErrorIfChanged(): void {
    const signature = JSON.stringify(this.violations);

    if (signature === this.lastViolationSignature) {
      return;
    }

    this.lastViolationSignature = signature;

    if (this.violations.length === 0) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent<MndwErrorDetail>(MNDW_ERROR_EVENT, {...EVENT_OPTIONS, detail: {violations: this.violations}}),
    );
  }

  private readonly onLocaleChange = (): void => {
    this.requestUpdate();
  };

  private readonly handleCheckboxChange = (event: Event): void => {
    const target = (event.composedPath()[0] ?? null) as HTMLElement | null;

    if (target === null) {
      return;
    }

    if (target.hasAttribute('data-select-all')) {
      const keys = this.displayRows.map((row) => resolveRowKey(this.rowKey, row));
      const next = toggleSelectAll(this.selected, keys);

      this.dispatchEvent(
        new CustomEvent<MndwSelectionChangeDetail>(MNDW_SELECTION_CHANGE_EVENT, {
          ...EVENT_OPTIONS,
          detail: {selected: next},
        }),
      );

      return;
    }

    const rowKey = target.getAttribute('data-row-key');

    if (rowKey !== null) {
      const next = toggleKey(this.selected, rowKey);

      this.dispatchEvent(
        new CustomEvent<MndwSelectionChangeDetail>(MNDW_SELECTION_CHANGE_EVENT, {
          ...EVENT_OPTIONS,
          detail: {selected: next},
        }),
      );
    }
  };

  private readonly handleClick = (event: Event): void => {
    const target = (event.composedPath()[0] ?? null) as HTMLElement | null;
    const sortButton = target?.closest?.('[data-sort-column]');

    if (sortButton !== null && sortButton !== undefined) {
      this.activateSort(sortButton.getAttribute('data-sort-column') ?? '');

      return;
    }

    if (
      target?.closest?.('[part="column-menu-trigger"]') !== null
      && target?.closest?.('[part="column-menu-trigger"]') !== undefined
    ) {
      this.openColumnMenu(target);
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const handle = (event.composedPath()[0] ?? null) as HTMLElement | null;

    if (handle?.getAttribute('part') !== 'drag-handle') {
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.keyboardReorder(handle.getAttribute('data-row-key') ?? '', event.key === 'ArrowUp' ? -1 : 1);
    }
  };

  private activateSort(columnId: string): void {
    const column = this.effectiveColumns.find((candidate) => candidate.id === columnId);

    if (column?.sortable !== true) {
      return;
    }

    const next = nextSortState(this.sort, columnId);

    this.dispatchEvent(
      new CustomEvent<MndwSortChangeDetail>(MNDW_SORT_CHANGE_EVENT, {
        ...EVENT_OPTIONS,
        detail: {sort: next},
      }),
    );
  }

  private keyboardReorder(key: string, direction: -1 | 1): void {
    const index = this.displayRows.findIndex((row) => resolveRowKey(this.rowKey, row) === key);

    if (index === -1) {
      return;
    }

    const targetIndex = index + direction;

    if (targetIndex < 0 || targetIndex >= this.displayRows.length) {
      return;
    }

    const beforeIndex = direction === -1 ? targetIndex : targetIndex + 1;
    const beforeKey = beforeIndex < this.displayRows.length
      ? resolveRowKey(this.rowKey, this.displayRows[beforeIndex])
      : null;

    this.emitReorder(key, beforeKey);
  }

  private emitReorder(key: string, beforeKey: string | null): void {
    const labels = this.resolveLabels();
    const row = this.displayRows.find((candidate) => resolveRowKey(this.rowKey, candidate) === key);

    this.announceText = row === undefined
      ? ''
      : labels.reordered(
        this.rowName(row, this.displayRows.indexOf(row)),
        this.displayRows.indexOf(row) + 1,
        this.displayRows.length,
      );

    this.dispatchEvent(
      new CustomEvent<MndwRowReorderDetail>(MNDW_ROW_REORDER_EVENT, {
        ...EVENT_OPTIONS,
        detail: {key, beforeKey},
      }),
    );
  }

  public applyColumnVisibility(hidden: string[]): void {
    this.dispatchEvent(
      new CustomEvent<MndwColumnVisibilityChangeDetail>(MNDW_COLUMN_VISIBILITY_CHANGE_EVENT, {
        ...EVENT_OPTIONS,
        detail: {hidden},
      }),
    );
  }

  public getVisibleColumnIds(): string[] {
    return this.effectiveColumns.filter((column) => !this.effectiveHidden.has(column.id)).map((column) => column.id);
  }

  private openColumnMenu(trigger: HTMLElement): void {
    if (this.menuLayer !== null) {
      return;
    }

    const options: MndwColumnMenuOption[] = this.effectiveColumns
      .filter((column) => column.hideable !== false)
      .map((column) => ({id: column.id, label: column.label}));

    const layer = getOverlayProvider().open({
      anchor: trigger,
      presentation: 'popover',
      className: this.columnMenuPanelClass || undefined,
      trapFocus: false,
      restoreFocus: false,
    });

    const menu = document.createElement(MNDW_COLUMN_MENU_TAG);

    menu.columns = options;
    menu.hiddenColumns = [...this.effectiveHidden];
    menu.addEventListener(MNDW_COLUMN_MENU_CHECK_EVENT, this.onColumnMenuCheck);
    menu.addEventListener('mndwpaneldismiss', this.onColumnMenuDismiss);
    layer.contentElement.appendChild(menu);
    this.menuLayer = layer;

    void menu.updateComplete.then(() => {
      if (this.menuLayer === layer) {
        layer.reposition();
        menu.focusFirstOption();
      }
    });

    void layer.closed.then(() => {
      this.forgetColumnMenu();
    });
  }

  private closeColumnMenu(): void {
    this.menuLayer?.close();
    this.forgetColumnMenu();
  }

  private forgetColumnMenu(): void {
    this.menuLayer = null;
  }

  private readonly onColumnMenuCheck = (event: Event): void => {
    const hidden = (event as CustomEvent<MndwColumnMenuCheckDetail>).detail.hidden;

    if (this.hiddenColumns !== undefined) {
      this.applyColumnVisibility(hidden);

      return;
    }

    this.visibilityState.applyInternal(hidden);
    this.requestUpdate();
    this.applyColumnVisibility(hidden);
  };

  private readonly onColumnMenuDismiss = (event: Event): void => {
    const restoreFocus = (event as CustomEvent<MndwPanelDismissDetail>).detail.restoreFocus;

    this.closeColumnMenu();

    if (restoreFocus) {
      this.shadowRoot?.querySelector<HTMLElement>('[part="column-menu-trigger"]')?.focus();
    }
  };
}

export type MndwTableElement = MndwTable<unknown>;

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- augmenting a DOM lib interface
  interface HTMLElementTagNameMap {
    'mndw-table': MndwTable<unknown>;
  }
}
