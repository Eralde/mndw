import {LitElement, type PropertyDeclarations, css, html, nothing} from 'lit';
import {repeat} from 'lit/directives/repeat.js';
import {getMndwUiText} from '../i18n.js';
import {LocaleController} from '../locale-controller.js';
import {type UiLayer, getOverlayProvider} from '../overlay.js';
import {focusRing, hostTypography, surfaceHover} from '../styles/base.js';
import {CellRegistry} from './table-cells.js';
import {type FocusChainEntry, resolveFocusedRowKey} from './table-focus.js';
import {
  type TableGeometryProvider,
  type TableMeasurementTarget,
  createDomTableGeometryProvider,
  lookupTableMeasurementTarget,
  registerTableMeasurementTarget,
} from './table-geometry.js';
import {type ScrollAnchor, TableVirtualizer, type VirtualRange} from './table-virtualizer.js';
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
  type CellRenderer,
  type Column,
  DETAIL_COL_ID,
  MNDW_COLUMN_VISIBILITY_CHANGE_EVENT,
  MNDW_ERROR_EVENT,
  MNDW_ROW_EXPAND_EVENT,
  MNDW_ROW_REORDER_EVENT,
  MNDW_SELECTION_CHANGE_EVENT,
  MNDW_SORT_CHANGE_EVENT,
  type MndwColumnVisibilityChangeDetail,
  type MndwErrorDetail,
  type MndwRowExpandDetail,
  type MndwRowReorderDetail,
  type MndwSelectionChangeDetail,
  type MndwSortChangeDetail,
  type MndwTableLabels,
  type PinDescriptor,
  type PinState,
  type RowKey,
  type ScrollToRowOptions,
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
    expandRow: (rowName) => `Expand ${rowName}`,
    collapseRow: (rowName) => `Collapse ${rowName}`,
  };
}

export class MndwTable<Row = unknown> extends LitElement {
  public static readonly properties: PropertyDeclarations = {
    columns: {type: Array, attribute: false},
    rows: {type: Array, attribute: false},
    rowKey: {type: String, attribute: 'row-key'},
    virtual: {type: Boolean, reflect: true},
    estimatedRowHeight: {type: Number, attribute: 'estimated-row-height', reflect: true},
    overscan: {type: Number, attribute: 'overscan', reflect: true},
    selectable: {type: Boolean, reflect: true},
    selected: {type: Array, attribute: false},
    reorderable: {type: Boolean, reflect: true},
    expandable: {type: Boolean, attribute: false},
    expandOn: {type: String, attribute: 'expand-on'},
    toggleCell: {type: String, attribute: 'toggle-cell'},
    toggleAfterColumn: {type: String, attribute: 'toggle-after-column'},
    expanded: {type: Array, attribute: false},
    expandedRenderer: {type: Object, attribute: false},
    sort: {type: Object, attribute: false},
    sortMode: {type: String, attribute: 'sort-mode'},
    hiddenColumns: {type: Array, attribute: false},
    columnMenu: {type: Boolean, attribute: false},
    columnMenuPanelClass: {type: String, attribute: 'column-menu-panel-class'},
    caption: {type: String},
    rowLabel: {type: Object, attribute: false},
    labels: {type: Object, attribute: false},
    emptyLabel: {type: String, attribute: 'empty-label'},
    layout: {type: String, reflect: true},
    minWidth: {type: String, attribute: 'min-width'},
    stickyHeader: {type: Boolean, attribute: 'sticky-header', reflect: true},
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
      overflow-anchor: none;
      scroll-behavior: auto !important;
      scrollbar-gutter: stable;
      /* Keep native table scrolling visually aligned with <mndw-scroll-area>'s custom scrollbar. */
      scrollbar-width: thin;
      scrollbar-color: var(--mndw-scrollbar-thumb) var(--mndw-scrollbar-track);
    }

    [part='viewport']::-webkit-scrollbar {
      width: var(--mndw-scrollbar-size);
      height: var(--mndw-scrollbar-size);
    }

    [part='viewport']::-webkit-scrollbar-track {
      background: var(--mndw-scrollbar-track);
    }

    [part='viewport']::-webkit-scrollbar-thumb {
      border: var(--mndw-focus-w) solid var(--mndw-scrollbar-track);
      border-radius: var(--mndw-scrollbar-radius);
      background: var(--mndw-scrollbar-thumb);
    }

    [part='viewport']::-webkit-scrollbar-thumb:hover {
      background: var(--mndw-scrollbar-thumb-hover);
    }

    [part='viewport']::-webkit-scrollbar-corner {
      background: var(--mndw-scrollbar-track);
    }

    [part='table'] {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    :host([layout='auto']) [part='table'] {
      table-layout: auto;
      width: max-content;
    }

    :host([virtual][layout='auto']) [part='table'] {
      table-layout: fixed;
      width: 100%;
    }

    [part='caption'] {
      text-align: start;
    }

    [part~='header-cell'] {
      text-align: start;
      padding: var(--mndw-space-2);
      border-bottom: 1px solid var(--mndw-border);
      font-size: var(--mndw-text-sm);
      color: var(--mndw-text-muted);
    }

    [part~='cell'] {
      padding: var(--mndw-space-2);
      border-bottom: 1px solid var(--mndw-border);
    }

    [part~='select-cell'] {
      width: 2.5rem;
      padding-inline: var(--mndw-space-1);
      text-align: center;
    }

    [part~='expand-cell'] {
      width: 2.5rem;
      padding-inline: var(--mndw-space-1);
      text-align: center;
    }

    [part='expand-toggle'] {
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: var(--mndw-space-1);
      font-size: var(--mndw-text-lg);
      line-height: 1;
    }

    [part='expand-toggle']:focus-visible {
      ${focusRing}
    }

    [part='detail-cell'] {
      padding: 0;
      border-bottom: 1px solid var(--mndw-border);
    }

    [part='detail-row'] [part='detail-cell'] {
      background: var(--mndw-surface-raised);
    }

    [part='row']:hover [part~='cell'] {
      ${surfaceHover}
    }

    .nowrap {
      white-space: nowrap;
    }

    .pinned {
      position: sticky;
      z-index: 1;
      background: var(--mndw-surface);
    }

    [part~='header-cell'].pinned {
      z-index: 2;
    }

    .pinned-last {
      border-inline-end: 1px solid var(--mndw-border);
    }

    :host([sticky-header]) [part~='header-cell'] {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--mndw-surface);
    }

    :host([sticky-header]) [part~='header-cell'].pinned {
      z-index: 3;
    }

    [part='sort-indicator'] {
      display: inline-flex;
      width: 1rem;
      flex: 0 0 1rem;
      align-items: center;
      justify-content: center;
      margin-inline-start: var(--mndw-space-1);
      color: var(--mndw-text-subtle);
    }

    [part='sort-indicator'][data-sorted] {
      color: var(--mndw-text);
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
      width: 0.5rem;
      height: 0.5rem;
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
  declare public virtual: boolean;
  declare public estimatedRowHeight: number;
  declare public overscan: number;
  declare public selectable: boolean;
  declare public selected: string[];
  declare public reorderable: boolean;
  declare public expandable: boolean;
  declare public expandOn: 'toggle' | 'row';
  declare public toggleCell: 'leading' | 'trailing';
  declare public toggleAfterColumn: string | undefined;
  declare public expanded: string[];
  declare public expandedRenderer: (() => CellRenderer<Row, Row>) | undefined;
  declare public sort: SortState | null;
  declare public sortMode: 'client' | 'manual';
  declare public hiddenColumns: string[] | undefined;
  declare public columnMenu: boolean;
  declare public columnMenuPanelClass: string;
  declare public caption: string;
  declare public rowLabel: ((row: Row) => string) | undefined;
  declare public labels: Partial<MndwTableLabels> | undefined;
  declare public emptyLabel: string;
  declare public layout: 'fixed' | 'auto';
  declare public minWidth: string;
  declare public stickyHeader: boolean;

  private readonly visibilityState = new ColumnVisibilityState();
  private readonly geometryProvider: TableGeometryProvider;
  private virtualizer: TableVirtualizer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly observedElements = new Set<Element>();
  private observedViewport: HTMLElement | null = null;
  private pendingGeometryFrame: number | null = null;
  private observerAttempted = false;
  private warnedInactiveReason: string | null = null;
  private warnedStickyReason: string | null = null;
  private pinState: PinState = {byKey: new Map(), inactiveReason: null, inactiveColumnId: null};
  private lastViewportContentWidth: number | undefined;
  private pendingScrollTarget: {key: string; align: 'start' | 'center' | 'end' | 'nearest'} | null = null;
  private expectedProgrammaticScrollTop: number | undefined;
  private cellRegistry: CellRegistry<Row> | null = null;
  private readonly localeController = new LocaleController(this);
  private menuLayer: UiLayer | null = null;

  private effectiveColumns: Column<Row>[] = [];
  private displayRows: Row[] = [];
  private effectiveHidden = new Set<string>();
  private effectiveSortState: SortState | null = null;
  private selectedKeySet = new Set<string>();
  private lastCellReconcileSignature: string | null = null;
  private lastExpandedKeys = new Set<string>();
  private windowRows: Row[] = [];
  private virtualRange: VirtualRange | null = null;
  private violations: Violation[] = [];
  private lastViolationSignature = '';
  private optimisticOrder: Row[] | null = null;
  private dragKey: string | null = null;
  private announceText = '';

  private static readonly WIDTH_EPSILON = 1;
  private static readonly UTILITY_COL_WIDTH = '2.5rem';
  private static readonly PIN_KEYS = {
    expandLead: '__mndw_pin_expandLead',
    select: '__mndw_pin_select',
    drag: '__mndw_pin_drag',
  } as const;

  constructor(geometryProvider?: TableGeometryProvider) {
    super();
    this.geometryProvider = geometryProvider ?? createDomTableGeometryProvider();
    this.columns = [];
    this.rows = [];
    this.rowKey = 'id' as RowKey<Row>;
    this.virtual = false;
    this.estimatedRowHeight = 49;
    this.overscan = 400;
    this.selectable = false;
    this.selected = [];
    this.reorderable = false;
    this.expandable = false;
    this.expandOn = 'toggle';
    this.toggleCell = 'leading';
    this.toggleAfterColumn = undefined;
    this.expanded = [];
    this.expandedRenderer = undefined;
    this.sort = null;
    this.sortMode = 'client';
    this.hiddenColumns = undefined;
    this.columnMenu = true;
    this.columnMenuPanelClass = '';
    this.caption = '';
    this.rowLabel = undefined;
    this.labels = undefined;
    this.emptyLabel = '';
    this.layout = 'fixed';
    this.minWidth = '';
    this.stickyHeader = false;

    this.addEventListener('mndwchange', this.handleCheckboxChange);
    this.addEventListener('click', this.handleClick);
    this.addEventListener('keydown', this.handleKeyDown);
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this.observerAttempted = false;
    this.cellRegistry = new CellRegistry<Row>(this);
    this.lastCellReconcileSignature = null;
  }

  public override disconnectedCallback(): void {
    this.teardownGeometry();
    this.closeColumnMenu();
    this.cellRegistry?.drain();
    this.cellRegistry = null;
    super.disconnectedCallback();
  }

  public override willUpdate(changedProperties: Map<string | number | symbol, unknown>): void {
    if (!this.hasUpdated || changedProperties.size > 0) {
      this.reconcileState(true);
    } else {
      this.updateVirtualWindow();
    }

    this.unobserveStaleGeometryTargets();
  }

  private reconcileState(forceCellReconcile: boolean): void {
    const previousSortState = this.effectiveSortState;
    const previousStructureSignature = this.logicalStructureSignature(this.displayRows, this.lastExpandedKeys);
    const anchorBeforeLogicalChange = this.captureCurrentAnchor();

    this.configureGeometryMode();
    this.configureLayoutMode();

    const columnViolations = validateColumns(this.columns);
    const {rows: validRows, violations: rowViolations} = validateRows(this.rows, this.rowKey);

    this.violations = [...columnViolations, ...rowViolations];
    this.emitErrorIfChanged();

    this.effectiveColumns = this.columns
      .filter((column, index, all) => all.findIndex((candidate) => candidate.id === column.id) === index)
      .filter((column) => !column.id.startsWith('__mndw_'));

    this.effectiveHidden = this.visibilityState.effectiveHidden(this.effectiveColumns, this.hiddenColumns);
    this.effectiveSortState = effectiveSort(this.effectiveColumns, this.sort, this.effectiveHidden);
    this.pinState = this.computePinState();
    this.applyStickyInactive(this.pinState);

    const sortChanged = !this.sameSortState(previousSortState, this.effectiveSortState);

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

    const expandedKeys = this.expandedSet();

    this.selectedKeySet = new Set(this.selected);

    const structureChanged =
      previousStructureSignature !== this.logicalStructureSignature(this.displayRows, expandedKeys);

    if (this.isVirtualRenderingActive()) {
      const virtualizer = this.getVirtualizer();
      const keys = this.displayRows.map((row) => resolveRowKey(this.rowKey, row));

      for (const key of this.lastExpandedKeys) {
        if (!expandedKeys.has(key)) {
          virtualizer.clearDetailMeasurement(key);
        }
      }

      virtualizer.configure({
        estimatedRowHeight: this.normalizedEstimatedRowHeight(),
        detailEstimate: 160,
      });
      virtualizer.setRows(keys, expandedKeys);

      this.updateVirtualWindow(false);

      if (sortChanged) {
        const viewport = this.viewportElement();
        const header = this.headerElement();

        if (viewport !== null && header !== null) {
          this.pendingScrollTarget = null;
          this.writeBodyScrollOffset(viewport, header, 0);
          this.updateVirtualWindow(false);
        }
      } else if (structureChanged && anchorBeforeLogicalChange !== undefined) {
        const viewport = this.viewportElement();
        const header = this.headerElement();

        if (viewport !== null && header !== null) {
          const currentRange = virtualizer.range(
            this.bodyScrollOffset(viewport, header),
            this.geometryProvider.getViewportClientHeight(viewport),
            this.normalizedOverscan(),
          );
          const maxBodyOffset = Math.max(
            0,
            currentRange.totalHeight - this.geometryProvider.getViewportClientHeight(viewport),
          );
          const restoredOffset = virtualizer.restoreAnchor(anchorBeforeLogicalChange, maxBodyOffset);

          this.writeBodyScrollOffset(viewport, header, restoredOffset);
          this.updateVirtualWindow(false);
        }
      }

      this.lastExpandedKeys = new Set(expandedKeys);
    } else {
      this.virtualRange = null;
      this.windowRows = this.displayRows;
    }

    if (
      this.pendingScrollTarget !== null
      && !this.displayRows.some((row) => resolveRowKey(this.rowKey, row) === this.pendingScrollTarget?.key)
    ) {
      this.pendingScrollTarget = null;
    }

    this.reconcileVisibleCells(forceCellReconcile, visibleColumnIds);
  }

  protected override updated(_changedProperties: Map<string | number | symbol, unknown>): void {
    if (!this.isVirtualRenderingActive()) {
      this.teardownGeometry();

      return;
    }

    this.syncGeometryTargets();
    this.scheduleGeometryFrame();
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
          <div class="mndw-table-viewport" part="viewport" tabindex="-1">
            <table
              part="table"
              style=${this.tableStyle()}
              aria-rowcount=${this.virtual ? this.logicalRowCount() : nothing}
            >
              ${this.caption ? html`<caption part="caption">${this.caption}</caption>` : nothing}
              ${this.renderHeader(labels)}
              <tbody>
                ${this.virtualRange === null ? nothing : this.renderSpacer(this.virtualRange.paddingBefore)}
                ${
          repeat(
            this.windowRows,
            (row) => resolveRowKey(this.rowKey, row),
            (row, index) => this.renderRow(row, index, labels),
          )
        }
                ${this.virtualRange === null ? nothing : this.renderSpacer(this.virtualRange.paddingAfter)}
              </tbody>
            </table>
          </div>`
    }
      <div part="live-region" aria-live="polite">${this.announceText}</div>
    `;
  }

  private renderSpacer(height: number): unknown {
    if (!Number.isFinite(height) || height <= 0) {
      return nothing;
    }

    return html`<tr part="virtual-spacer" aria-hidden="true">
      <td colspan=${this.columnSpan()} style="height: ${height}px; padding: 0; border: 0;"></td>
    </tr>`;
  }

  private renderHeader(labels: MndwTableLabels): unknown {
    return html`
      <thead part="header">
        <tr part="header-row" aria-rowindex=${this.virtual ? 1 : nothing}>
          ${this.shouldRenderLeadingToggle() ? this.renderExpandHeaderCell(MndwTable.PIN_KEYS.expandLead) : nothing}
          ${
      this.selectable
        ? html`<th
            part="header-cell select-cell"
            scope="col"
            class=${classAttr(this.pinClasses(MndwTable.PIN_KEYS.select))}
            style=${this.utilityPinStyle(MndwTable.PIN_KEYS.select)}
          >
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
          ${
      this.reorderable && this.effectiveSortState === null
        ? html`<th
            part="header-cell"
            scope="col"
            class=${classAttr(this.pinClasses(MndwTable.PIN_KEYS.drag))}
            style=${this.utilityPinStyle(MndwTable.PIN_KEYS.drag)}
          ></th>`
        : nothing
    }
          ${
      this.effectiveColumns
        .filter((column) => !this.effectiveHidden.has(column.id))
        .map((column) =>
          html`
          ${this.renderHeaderCell(column, labels)}
          ${this.shouldRenderToggleAfter(column.id) ? this.renderExpandHeaderCell() : nothing}
        `
        )
    }
          ${
      this.columnMenu
        ? html`<th part="header-cell" scope="col" class="align-end">
              <button
                part="column-menu-trigger"
                class="sort-button"
                type="button"
                aria-label=${labels.columnMenu}
              ><mndw-icon name="settings"></mndw-icon></button>
            </th>`
        : nothing
    }
          ${this.shouldRenderTrailingToggle() ? this.renderExpandHeaderCell() : nothing}
        </tr>
      </thead>
    `;
  }

  private renderExpandHeaderCell(pinKey?: string): unknown {
    return html`<th
      part="header-cell expand-cell"
      scope="col"
      class=${classAttr(pinKey === undefined ? [] : this.pinClasses(pinKey))}
      style=${pinKey === undefined ? nothing : this.utilityPinStyle(pinKey)}
    ></th>`;
  }

  private renderHeaderCell(column: Column<Row>, labels: MndwTableLabels): unknown {
    const align = classAttr([...this.alignClassList(column), ...this.pinClasses(column.id)]);
    const style = this.columnStyle(column);

    if (column.sortable !== true) {
      return html`<th part="header-cell" scope="col" class=${align} style=${style}>${column.label}</th>`;
    }

    const direction = this.effectiveSortState?.columnId === column.id ? this.effectiveSortState?.direction : undefined;
    const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : nothing;
    const indicatorName = direction === 'asc'
      ? 'arrow-up'
      : direction === 'desc'
      ? 'arrow-down'
      : 'arrow-up-down';

    return html`
      <th part="header-cell" scope="col" class=${align} style=${style} aria-sort=${ariaSort}>
        <button
          class="sort-button"
          type="button"
          data-sort-column=${column.id}
          aria-label=${labels.sortBy(column.label)}
        >${column.label}<span part="sort-indicator" ?data-sorted=${direction !== undefined}>
          <mndw-icon name=${indicatorName}></mndw-icon>
        </span></button>
      </th>
    `;
  }

  private renderRow(row: Row, index: number, labels: MndwTableLabels): unknown {
    const key = resolveRowKey(this.rowKey, row);
    const isExpanded = this.expandedSet().has(key);
    const detailSlot = this.cellRegistry?.getSlotId(key, DETAIL_COL_ID);

    return html`
      <tr part="row" data-row-key=${key} aria-rowindex=${this.virtual ? this.logicalRowIndex(key, false) : nothing}>
        ${
      this.shouldRenderLeadingToggle()
        ? this.renderExpandCell(row, index, key, labels, MndwTable.PIN_KEYS.expandLead)
        : nothing
    }
        ${
      this.selectable
        ? html`<td
            part="select-cell cell"
            class=${classAttr(this.pinClasses(MndwTable.PIN_KEYS.select))}
            style=${this.utilityPinStyle(MndwTable.PIN_KEYS.select)}
          >
            ${
          this.renderCheckbox({
            ariaLabel: labels.selectRow(this.rowName(row, index)),
            checked: this.selectedKeySet.has(key),
            indeterminate: false,
            rowKey: key,
          })
        }
          </td>`
        : nothing
    }
        ${
      this.reorderable && this.effectiveSortState === null
        ? html`<td
            part="cell"
            class=${classAttr(this.pinClasses(MndwTable.PIN_KEYS.drag))}
            style=${this.utilityPinStyle(MndwTable.PIN_KEYS.drag)}
          >
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
        .map((column) =>
          html`
          ${this.renderCell(column, row)}
          ${this.shouldRenderToggleAfter(column.id) ? this.renderExpandCell(row, index, key, labels) : nothing}
        `
        )
    }
        ${this.columnMenu ? html`<td part="cell"></td>` : nothing}
        ${this.shouldRenderTrailingToggle() ? this.renderExpandCell(row, index, key, labels) : nothing}
      </tr>
      ${
      this.expandable && isExpanded
        ? html`<tr
          part="detail-row"
          data-row-key=${key}
          aria-rowindex=${this.virtual ? this.logicalRowIndex(key, true) : nothing}
        ><td part="detail-cell" colspan=${this.columnSpan()}>${
          detailSlot !== undefined
            ? html`<slot name=${detailSlot}></slot>`
            : nothing
        }</td></tr>`
        : nothing
    }
    `;
  }

  private renderExpandCell(row: Row, index: number, key: string, labels: MndwTableLabels, pinKey?: string): unknown {
    const isExpanded = this.expandedSet().has(key);
    const name = this.rowName(row, index);

    return html`<td
      part="cell expand-cell"
      class=${classAttr(pinKey === undefined ? [] : this.pinClasses(pinKey))}
      style=${pinKey === undefined ? nothing : this.utilityPinStyle(pinKey)}
    >
      <button
        part="expand-toggle"
        type="button"
        data-expand-key=${key}
        aria-expanded=${isExpanded ? 'true' : 'false'}
        aria-label=${isExpanded ? labels.collapseRow(name) : labels.expandRow(name)}
      ><mndw-icon name=${isExpanded ? 'chevron-down' : 'chevron-right'}></mndw-icon></button>
    </td>`;
  }

  private renderCell(column: Column<Row>, row: Row): unknown {
    const align = [...this.alignClassList(column), ...this.pinClasses(column.id)];
    const style = this.columnStyle(column);
    const slotId = column.renderer !== undefined
      ? this.cellRegistry?.getSlotId(resolveRowKey(this.rowKey, row), column.id)
      : undefined;

    // Custom-renderer cells: align classes only, NO cell-kind-number (matches the old build order).
    if (slotId !== undefined) {
      return html`<td part="cell" class=${classAttr(align)} style=${style}><slot name=${slotId}></slot></td>`;
    }

    const classes = column.kind === 'number' ? [...align, 'cell-kind-number'] : align;
    const value = resolveCellValue(column, row);

    return html`<td part="cell" class=${classAttr(classes)} style=${style}>${
      this.renderBuiltIn(column, value, row)
    }</td>`;
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
      return value
        ? html`<mndw-icon name="check"></mndw-icon>`
        : html`<mndw-icon name="minus"></mndw-icon>`;
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

  private expandedSet(): Set<string> {
    return new Set(this.expanded);
  }

  private getVirtualizer(): TableVirtualizer {
    if (this.virtualizer === null) {
      this.virtualizer = new TableVirtualizer({
        estimatedRowHeight: this.normalizedEstimatedRowHeight(),
        detailEstimate: 160,
      });
    }

    return this.virtualizer;
  }

  private captureCurrentAnchor(): ScrollAnchor | undefined {
    if (!this.isVirtualRenderingActive() || this.virtualizer === null) {
      return undefined;
    }

    const viewport = this.viewportElement();
    const header = this.headerElement();

    return viewport === null || header === null
      ? undefined
      : this.virtualizer.captureAnchor(this.bodyScrollOffset(viewport, header));
  }

  private logicalStructureSignature(rows: readonly Row[], expandedKeys: ReadonlySet<string>): string {
    return [
      rows.map((row) => resolveRowKey(this.rowKey, row)).join('\u0000'),
      [...expandedKeys].join('\u0000'),
    ].join('\u0001');
  }

  private configureGeometryMode(): void {
    if (!this.virtual) {
      this.setVirtualInactiveReason(null);
      this.teardownGeometry();

      return;
    }

    if (this.resizeObserver === null && !this.observerAttempted) {
      this.observerAttempted = true;
      this.resizeObserver = this.geometryProvider.createResizeObserver(this.handleGeometryResize);
    }

    if (this.resizeObserver === null) {
      this.setVirtualInactiveReason('resize-observer-unavailable');

      return;
    }

    if (this.reorderable) {
      this.teardownGeometry();
      this.setVirtualInactiveReason('reorderable');

      return;
    }

    this.setVirtualInactiveReason(null);
  }

  private configureLayoutMode(): void {
    const inactive = this.virtual && this.layout === 'auto';

    if (inactive) {
      this.setAttribute('data-mndw-layout-inactive', 'virtual');
    } else {
      this.removeAttribute('data-mndw-layout-inactive');
    }
  }

  private isVirtualRenderingActive(): boolean {
    return this.virtual && !this.reorderable && this.resizeObserver !== null;
  }

  private setVirtualInactiveReason(reason: string | null): void {
    if (reason === null) {
      this.removeAttribute('data-mndw-virtual-inactive');
    } else {
      this.setAttribute('data-mndw-virtual-inactive', reason);

      if (this.warnedInactiveReason !== reason) {
        this.warnedInactiveReason = reason;
        console.warn(`<${MNDW_TABLE_TAG}> virtualization inactive: ${reason}`);
      }
    }
  }

  private updateVirtualWindow(reconcileCells = true): void {
    if (!this.isVirtualRenderingActive() || this.virtualizer === null) {
      return;
    }

    const viewport = this.viewportElement();
    const header = this.headerElement();
    const scrollOffset = viewport === null || header === null ? 0 : this.bodyScrollOffset(viewport, header);
    const viewportHeight = viewport === null ? 0 : this.geometryProvider.getViewportClientHeight(viewport);

    this.virtualRange = this.virtualizer.range(scrollOffset, viewportHeight, this.normalizedOverscan());

    const nextRows = this.displayRows.slice(this.virtualRange.start, this.virtualRange.end);

    if (viewport !== null && this.windowRows !== nextRows) {
      const previousWindow = this.windowRows.map((row) => resolveRowKey(this.rowKey, row)).join('\u0000');
      const nextWindow = nextRows.map((row) => resolveRowKey(this.rowKey, row)).join('\u0000');

      if (previousWindow !== nextWindow) {
        this.evacuateFocusBeforeWindowRemoval(viewport, this.windowRows, nextRows);
      }
    }

    this.windowRows = nextRows;

    if (reconcileCells) {
      this.reconcileVisibleCells(false);
    }
  }

  private reconcileVisibleCells(force: boolean, visibleColumnIds?: ReadonlySet<string>): void {
    const visibleIds = visibleColumnIds ?? new Set(
      this.effectiveColumns.filter((column) => !this.effectiveHidden.has(column.id)).map((column) => column.id),
    );
    const signature = [
      this.windowRows.map((row) => resolveRowKey(this.rowKey, row)).join('\u0000'),
      [...visibleIds].join('\u0000'),
      [...this.expandedSet()].join('\u0000'),
    ].join('\u0001');

    if (!force && signature === this.lastCellReconcileSignature) {
      return;
    }

    this.cellRegistry?.reconcile(
      this.windowRows,
      (row) => resolveRowKey(this.rowKey, row),
      this.effectiveColumns,
      visibleIds,
      resolveCellValue,
      this.expandedSet(),
      this.expandedRenderer as (() => CellRenderer<Row>) | undefined,
    );
    this.lastCellReconcileSignature = signature;
  }

  private bodyScrollOffset(viewport: HTMLElement, header: HTMLElement): number {
    return Math.max(
      0,
      this.geometryProvider.getViewportScrollTop(viewport) - this.geometryProvider.measure(header).height,
    );
  }

  private writeBodyScrollOffset(viewport: HTMLElement, header: HTMLElement, bodyOffset: number): void {
    if (this.virtualizer === null) {
      return;
    }

    const headerHeight = this.geometryProvider.measure(header).height;
    const viewportHeight = this.geometryProvider.getViewportClientHeight(viewport);
    const currentScrollTop = this.geometryProvider.getViewportScrollTop(viewport);
    const totalHeight = this.virtualizer.range(
      this.bodyScrollOffset(viewport, header),
      viewportHeight,
      this.normalizedOverscan(),
    ).totalHeight;
    const maxScrollTop = Math.max(0, headerHeight + totalHeight - viewportHeight);
    const requestedScrollTop = bodyOffset <= 0 && currentScrollTop < headerHeight
      ? currentScrollTop
      : headerHeight + Math.max(0, bodyOffset);

    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, requestedScrollTop));

    this.expectedProgrammaticScrollTop = nextScrollTop;
    this.geometryProvider.setViewportScrollTop(viewport, nextScrollTop);
  }

  private syncGeometryTargets(): void {
    const observer = this.resizeObserver;
    const viewport = this.viewportElement();
    const header = this.headerElement();

    if (observer === null || viewport === null || header === null) {
      return;
    }

    const targets = new Map<Element, TableMeasurementTarget>();

    targets.set(viewport, {kind: 'viewport'});
    targets.set(header, {kind: 'header'});

    for (const row of this.shadowRoot?.querySelectorAll<HTMLElement>('[part="row"]') ?? []) {
      const rowKey = row.getAttribute('data-row-key');

      if (rowKey !== null && rowKey !== '') {
        targets.set(row, {kind: 'summary', rowKey});
      }
    }

    for (const detail of this.shadowRoot?.querySelectorAll<HTMLElement>('[part="detail-row"]') ?? []) {
      const rowKey = detail.getAttribute('data-row-key');

      if (rowKey !== null && rowKey !== '') {
        targets.set(detail, {kind: 'detail', rowKey});
      }
    }

    for (const element of this.observedElements) {
      if (!targets.has(element)) {
        observer.unobserve(element);
        this.observedElements.delete(element);
      }
    }

    for (const [element, target] of targets) {
      registerTableMeasurementTarget(element, target);

      if (!this.observedElements.has(element)) {
        observer.observe(element);
        this.observedElements.add(element);
      }
    }

    if (this.observedViewport !== viewport) {
      this.observedViewport?.removeEventListener('scroll', this.handleViewportScroll);
      viewport.addEventListener('scroll', this.handleViewportScroll);
      this.observedViewport = viewport;
    }
  }

  private unobserveStaleGeometryTargets(): void {
    if (this.resizeObserver === null) {
      return;
    }

    const desiredKeys = new Set(this.windowRows.map((row) => resolveRowKey(this.rowKey, row)));
    const expandedKeys = this.expandedSet();

    for (const element of this.observedElements) {
      const target = lookupTableMeasurementTarget(element);

      if (
        target?.kind === 'summary' && !desiredKeys.has(target.rowKey)
        || target?.kind === 'detail' && (!desiredKeys.has(target.rowKey) || !expandedKeys.has(target.rowKey))
      ) {
        this.resizeObserver.unobserve(element);
        this.observedElements.delete(element);
      }
    }
  }

  private scheduleGeometryFrame(): void {
    if (!this.isVirtualRenderingActive() || this.pendingGeometryFrame !== null) {
      return;
    }

    this.pendingGeometryFrame = this.geometryProvider.requestAnimationFrame(this.handleGeometryFrame);
  }

  private readonly handleGeometryResize: ResizeObserverCallback = (): void => {
    this.scheduleGeometryFrame();
  };

  private readonly handleViewportScroll = (): void => {
    const viewport = this.observedViewport;

    if (viewport !== null && this.expectedProgrammaticScrollTop !== undefined) {
      const current = this.geometryProvider.getViewportScrollTop(viewport);

      if (Math.abs(current - this.expectedProgrammaticScrollTop) <= 0.25) {
        this.expectedProgrammaticScrollTop = undefined;
        this.scheduleGeometryFrame();

        return;
      }
    }

    this.pendingScrollTarget = null;
    this.scheduleGeometryFrame();
  };

  private readonly handleGeometryFrame: FrameRequestCallback = (): void => {
    this.pendingGeometryFrame = null;

    if (!this.isConnected || !this.isVirtualRenderingActive() || this.virtualizer === null) {
      return;
    }

    const viewport = this.viewportElement();
    const header = this.headerElement();

    if (viewport === null || header === null) {
      return;
    }

    this.geometryProvider.measure(viewport);

    const headerRect = this.geometryProvider.measure(header);
    const nextWidth = this.geometryProvider.getViewportContentWidth(viewport);
    const bodyOffsetBeforeMeasure = this.bodyScrollOffset(viewport, header);
    const anchor = this.virtualizer.captureAnchor(bodyOffsetBeforeMeasure);
    let geometryChanged = false;

    if (this.lastViewportContentWidth === undefined) {
      this.lastViewportContentWidth = nextWidth;
    } else if (
      Number.isFinite(nextWidth)
      && Math.abs(nextWidth - this.lastViewportContentWidth) >= MndwTable.WIDTH_EPSILON
    ) {
      this.lastViewportContentWidth = nextWidth;
      this.virtualizer.resetWidthEpoch();
      geometryChanged = true;
    }

    for (const element of this.observedElements) {
      const target = lookupTableMeasurementTarget(element);

      if (target?.kind === 'summary') {
        geometryChanged =
          this.virtualizer.recordSummaryMeasurement(target.rowKey, this.geometryProvider.measure(element).height)
          || geometryChanged;
      } else if (target?.kind === 'detail') {
        geometryChanged =
          this.virtualizer.recordDetailMeasurement(target.rowKey, this.geometryProvider.measure(element).height)
          || geometryChanged;
      }
    }

    const scrollOffset = Math.max(
      0,
      this.geometryProvider.getViewportScrollTop(viewport) - headerRect.height,
    );
    const nextRange = this.virtualizer.range(
      scrollOffset,
      this.geometryProvider.getViewportClientHeight(viewport),
      this.normalizedOverscan(),
    );
    const previousWindow = this.windowRows.map((row) => resolveRowKey(this.rowKey, row)).join('\u0000');
    const nextRows = this.displayRows.slice(nextRange.start, nextRange.end);
    const nextWindow = nextRows.map((row) => resolveRowKey(this.rowKey, row)).join('\u0000');

    if (previousWindow !== nextWindow) {
      this.evacuateFocusBeforeWindowRemoval(viewport, this.windowRows, nextRows);
    }

    this.virtualRange = nextRange;
    this.windowRows = nextRows;
    this.reconcileVisibleCells(false);

    let targetCorrected = false;

    if (this.pendingScrollTarget !== null) {
      const target = this.pendingScrollTarget;
      const targetElement = [...this.observedElements].find((element) => {
        const measurementTarget = lookupTableMeasurementTarget(element);

        return measurementTarget?.kind === 'summary' && measurementTarget.rowKey === target.key;
      });

      if (targetElement !== undefined) {
        const targetOffset = this.virtualizer.offsetForRow(
          target.key,
          target.align,
          this.geometryProvider.getViewportClientHeight(viewport),
          scrollOffset,
        );

        if (targetOffset !== undefined) {
          this.writeBodyScrollOffset(viewport, header, targetOffset);
        }

        this.pendingScrollTarget = null;
        targetCorrected = true;
      }
    }

    if (geometryChanged && !targetCorrected && anchor !== undefined) {
      const maxBodyOffset = Math.max(
        0,
        nextRange.totalHeight - this.geometryProvider.getViewportClientHeight(viewport),
      );
      const restoredOffset = this.virtualizer.restoreAnchor(anchor, maxBodyOffset);

      this.writeBodyScrollOffset(viewport, header, restoredOffset);
    }

    if (geometryChanged || previousWindow !== nextWindow) {
      this.requestUpdate();
    }
  };

  private teardownGeometry(): void {
    this.observedViewport?.removeEventListener('scroll', this.handleViewportScroll);
    this.observedViewport = null;

    if (this.resizeObserver !== null) {
      for (const element of this.observedElements) {
        this.resizeObserver.unobserve(element);
      }

      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.observedElements.clear();
    this.observerAttempted = false;

    if (this.pendingGeometryFrame !== null) {
      this.geometryProvider.cancelAnimationFrame(this.pendingGeometryFrame);
      this.pendingGeometryFrame = null;
    }

    this.lastViewportContentWidth = undefined;
    this.expectedProgrammaticScrollTop = undefined;
  }

  private normalizedEstimatedRowHeight(): number {
    return Number.isFinite(this.estimatedRowHeight) && this.estimatedRowHeight > 0
      ? this.estimatedRowHeight
      : 49;
  }

  private normalizedOverscan(): number {
    return Number.isFinite(this.overscan) && this.overscan >= 0 ? this.overscan : 400;
  }

  private viewportElement(): HTMLElement | null {
    return this.shadowRoot?.querySelector<HTMLElement>('[part="viewport"]') ?? null;
  }

  private headerElement(): HTMLElement | null {
    return this.shadowRoot?.querySelector<HTMLElement>('[part="header-row"]') ?? null;
  }

  private collectFocusChain(): FocusChainEntry[] {
    const chain: FocusChainEntry[] = [];
    let activeElement: Element | null = document.activeElement;

    while (activeElement !== null) {
      chain.push({rowKey: this.focusedRowKeyForElement(activeElement)});

      const nestedActive = activeElement.shadowRoot?.activeElement;

      if (!(nestedActive instanceof Element) || nestedActive === activeElement) {
        break;
      }

      activeElement = nestedActive;
    }

    return chain;
  }

  private focusedRowKeyForElement(element: Element): string | undefined {
    const parkedRowKey = this.cellRegistry?.getRowKeyForNode(element);

    if (parkedRowKey !== undefined) {
      return parkedRowKey;
    }

    return element.closest('[part="row"], [part="detail-row"]')?.getAttribute('data-row-key') ?? undefined;
  }

  private evacuateFocusBeforeWindowRemoval(
    viewport: HTMLElement,
    previousRows: readonly Row[],
    nextRows: readonly Row[],
  ): void {
    const previousKeys = new Set(previousRows.map((row) => resolveRowKey(this.rowKey, row)));
    const nextKeys = new Set(nextRows.map((row) => resolveRowKey(this.rowKey, row)));
    const focusedKey = resolveFocusedRowKey(this.collectFocusChain());

    if (focusedKey !== undefined && previousKeys.has(focusedKey) && !nextKeys.has(focusedKey)) {
      viewport.focus();
    }
  }

  private shouldRenderLeadingToggle(): boolean {
    return this.expandable && this.toggleAfterColumn === undefined && this.toggleCell === 'leading';
  }

  private shouldRenderTrailingToggle(): boolean {
    return this.expandable && this.toggleAfterColumn === undefined && this.toggleCell === 'trailing';
  }

  private shouldRenderToggleAfter(columnId: string): boolean {
    return this.expandable && this.toggleAfterColumn === columnId;
  }

  private leadingUtilityKeys(): string[] {
    const keys: string[] = [];

    if (this.shouldRenderLeadingToggle()) {
      keys.push(MndwTable.PIN_KEYS.expandLead);
    }

    if (this.selectable) {
      keys.push(MndwTable.PIN_KEYS.select);
    }

    if (this.reorderable && this.effectiveSortState === null) {
      keys.push(MndwTable.PIN_KEYS.drag);
    }

    return keys;
  }

  private computePinState(): PinState {
    const visible = this.effectiveColumns.filter((column) => !this.effectiveHidden.has(column.id));
    const pinnedData: (Column<Row> & {width: string})[] = [];
    let inactiveReason: PinState['inactiveReason'] = null;
    let inactiveColumnId: string | null = null;

    for (const column of visible) {
      if (column.sticky !== 'start') {
        break;
      }

      if (column.width === undefined) {
        inactiveReason = 'missing-width';
        inactiveColumnId = column.id;
        break;
      }

      pinnedData.push({...column, width: column.width});
    }

    if (inactiveReason === null) {
      const offending = visible.slice(pinnedData.length).find((column) => column.sticky === 'start');

      if (offending !== undefined) {
        inactiveReason = 'not-leading';
        inactiveColumnId = offending.id;
      }
    }

    const byKey = new Map<string, PinDescriptor>();

    if (pinnedData.length > 0) {
      const slots: {key: string; width: string}[] = [
        ...this.leadingUtilityKeys().map((key) => ({key, width: MndwTable.UTILITY_COL_WIDTH})),
        ...pinnedData.map((column) => ({key: column.id, width: column.width})),
      ];
      const widthsSoFar: string[] = [];

      slots.forEach((slot, index) => {
        const inset = widthsSoFar.length === 0
          ? '0'
          : widthsSoFar.length === 1
          ? widthsSoFar[0]
          : `calc(${widthsSoFar.join(' + ')})`;

        byKey.set(slot.key, {insetInlineStart: inset, isLast: index === slots.length - 1});
        widthsSoFar.push(slot.width);
      });
    }

    return {byKey, inactiveReason, inactiveColumnId};
  }

  private applyStickyInactive(state: PinState): void {
    if (state.inactiveReason === null) {
      this.removeAttribute('data-mndw-sticky-inactive');
      this.warnedStickyReason = null;

      return;
    }

    this.setAttribute('data-mndw-sticky-inactive', state.inactiveReason);

    const signature = `${state.inactiveReason}:${state.inactiveColumnId ?? ''}`;

    if (this.warnedStickyReason !== signature) {
      this.warnedStickyReason = signature;
      console.warn(
        `<${MNDW_TABLE_TAG}> sticky column "${state.inactiveColumnId ?? ''}" inactive: ${state.inactiveReason}`,
      );
    }
  }

  private tableStyle(): string | typeof nothing {
    return this.minWidth === '' ? nothing : `min-width: ${this.minWidth};`;
  }

  private columnStyle(column: Column<Row>): string | typeof nothing {
    const pin = this.pinState.byKey.get(column.id);
    const parts: string[] = [];

    if (column.width !== undefined) {
      parts.push(`width: ${column.width};`);
    }

    if (pin !== undefined && column.width !== undefined) {
      parts.push(
        `min-width: ${column.width};`,
        `max-width: ${column.width};`,
        'box-sizing: border-box;',
        `inset-inline-start: ${pin.insetInlineStart};`,
      );
    }

    return parts.length === 0 ? nothing : parts.join(' ');
  }

  private pinClasses(key: string): string[] {
    const pin = this.pinState.byKey.get(key);

    if (pin === undefined) {
      return [];
    }

    return pin.isLast ? ['pinned', 'pinned-last'] : ['pinned'];
  }

  private utilityPinStyle(key: string): string | typeof nothing {
    const pin = this.pinState.byKey.get(key);

    if (pin === undefined) {
      return nothing;
    }

    const width = MndwTable.UTILITY_COL_WIDTH;

    return `width: ${width}; min-width: ${width}; max-width: ${width}; box-sizing: border-box; inset-inline-start: ${pin.insetInlineStart};`;
  }

  private columnSpan(): number {
    const visibleData = this.effectiveColumns.filter((column) => !this.effectiveHidden.has(column.id)).length;

    return (this.expandable ? 1 : 0)
      + (this.selectable ? 1 : 0)
      + (this.reorderable && this.effectiveSortState === null ? 1 : 0)
      + visibleData
      + (this.columnMenu ? 1 : 0);
  }

  private alignClassList(column: Column<Row>): string[] {
    const classes: string[] = [];

    if (column.align === 'end') {
      classes.push('align-end');
    }

    if (column.align === 'center') {
      classes.push('align-center');
    }

    if (column.nowrap === true) {
      classes.push('nowrap');
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

  private sameSortState(left: SortState | null, right: SortState | null): boolean {
    return left?.columnId === right?.columnId && left?.direction === right?.direction;
  }

  private logicalRowCount(): number {
    const expandedKeys = this.expandedSet();
    const validKeys = new Set(this.displayRows.map((row) => resolveRowKey(this.rowKey, row)));
    const detailCount = [...expandedKeys].filter((key) => validKeys.has(key)).length;

    return 1 + this.displayRows.length + detailCount;
  }

  private logicalRowIndex(key: string, detail: boolean): number {
    let rowIndex = 2;
    const expandedKeys = this.expandedSet();

    for (const row of this.displayRows) {
      const rowKey = resolveRowKey(this.rowKey, row);

      if (rowKey === key) {
        return detail ? rowIndex + 1 : rowIndex;
      }

      rowIndex += 1;

      if (expandedKeys.has(rowKey)) {
        rowIndex += 1;
      }
    }

    return rowIndex;
  }

  private locale(): string {
    return document.documentElement.lang || 'en';
  }

  private isAllSelected(): boolean {
    return selectAllState(this.selectedKeySet, this.displayRows.map((row) => resolveRowKey(this.rowKey, row)))
      === 'all';
  }

  private isIndeterminate(): boolean {
    return selectAllState(this.selectedKeySet, this.displayRows.map((row) => resolveRowKey(this.rowKey, row)))
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
    const target = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement) ?? null;
    const expandToggle = target?.closest?.('[part="expand-toggle"]');

    if (expandToggle !== null && expandToggle !== undefined) {
      this.emitExpand(expandToggle.getAttribute('data-expand-key') ?? '');

      return;
    }

    if (this.expandable && this.expandOn === 'row') {
      const path = event.composedPath();
      const interactive = path.some((node) =>
        node instanceof HTMLElement && (
          node.tagName === 'BUTTON'
          || node.tagName === 'A'
          || node.tagName === 'INPUT'
          || node.tagName === 'MNDW-CHECKBOX'
          || node.getAttribute('part') === 'drag-handle'
          || node.hasAttribute('data-no-expand')
        )
      );

      if (!interactive) {
        const row = path.find((node) => node instanceof HTMLElement && node.getAttribute('part') === 'row');
        const key = row instanceof HTMLElement ? row.getAttribute('data-row-key') : null;

        if (key !== null && key !== undefined && key !== '') {
          this.emitExpand(key);
        }
      }
    }

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

  private emitExpand(key: string): void {
    const expanded = new Set(this.expanded);

    if (expanded.has(key)) {
      expanded.delete(key);
    } else {
      expanded.add(key);
    }

    this.dispatchEvent(
      new CustomEvent<MndwRowExpandDetail>(MNDW_ROW_EXPAND_EVENT, {
        ...EVENT_OPTIONS,
        detail: {expanded: [...expanded]},
      }),
    );
  }

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

  public scrollToRow(key: string, options: ScrollToRowOptions = {}): boolean {
    const rowExists = this.displayRows.some((row) => resolveRowKey(this.rowKey, row) === key);

    if (!rowExists) {
      return false;
    }

    const viewport = this.viewportElement();
    const header = this.headerElement();

    if (viewport === null || header === null) {
      return false;
    }

    const virtualizer = this.getVirtualizer();

    virtualizer.configure({estimatedRowHeight: this.normalizedEstimatedRowHeight(), detailEstimate: 160});
    virtualizer.setRows(
      this.displayRows.map((row) => resolveRowKey(this.rowKey, row)),
      this.expandedSet(),
    );

    const align = options.align ?? 'nearest';
    const bodyOffset = virtualizer.offsetForRow(
      key,
      align,
      this.geometryProvider.getViewportClientHeight(viewport),
      this.bodyScrollOffset(viewport, header),
    );

    if (bodyOffset === undefined) {
      return false;
    }

    if (this.isVirtualRenderingActive()) {
      this.pendingScrollTarget = {key, align};
    }

    this.writeBodyScrollOffset(viewport, header, bodyOffset);
    this.updateVirtualWindow();

    if (this.isVirtualRenderingActive()) {
      this.requestUpdate();
    }

    return true;
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
