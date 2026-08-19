import type {CellContext, CellRenderer, Column} from './table-types.js';

export interface CellEntry<Row> {
  readonly slotId: string;
  readonly node: HTMLElement;
  readonly renderer: CellRenderer<Row>;
  readonly rendererFactory: (() => CellRenderer<Row>) | undefined;
  readonly rowKey: string;
  readonly colId: string;
}

export class CellRegistry<Row> {
  private readonly entries = new Map<string, Map<string, CellEntry<Row>>>();
  private readonly host: HTMLElement;
  private nextSlotId = 1;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  public reconcile(
    rows: Row[],
    resolveKey: (row: Row) => string,
    columns: Column<Row>[],
    visibleColumnIds: ReadonlySet<string>,
    readValue: (column: Column<Row>, row: Row) => unknown,
  ): void {
    const desiredKeys = new Set<string>();

    for (const row of rows) {
      this.reconcileRow(row, resolveKey(row), columns, visibleColumnIds, readValue, desiredKeys);
    }

    this.pruneRemoved(desiredKeys);
  }

  private reconcileRow(
    row: Row,
    rowKey: string,
    columns: Column<Row>[],
    visibleColumnIds: ReadonlySet<string>,
    readValue: (column: Column<Row>, row: Row) => unknown,
    desiredKeys: Set<string>,
  ): void {
    let colMap = this.entries.get(rowKey);

    if (colMap === undefined) {
      colMap = new Map<string, CellEntry<Row>>();
      this.entries.set(rowKey, colMap);
    }

    for (const column of columns) {
      if (column.renderer === undefined || !visibleColumnIds.has(column.id)) {
        continue;
      }

      desiredKeys.add(`${rowKey}\u0000${column.id}`);

      const existing = colMap.get(column.id);
      const context: CellContext<Row> = {
        node: existing?.node ?? document.createElement('div'),
        row,
        value: readValue(column, row),
        colId: column.id,
      };

      if (existing?.rendererFactory === column.renderer) {
        existing.renderer.update(context);

        continue;
      }

      if (existing !== undefined) {
        existing.renderer.destroy();
        existing.node.remove();
      }

      const renderer = column.renderer();
      const node = context.node;

      node.setAttribute('slot', `mc-${this.nextSlotId++}`);
      this.host.appendChild(node);

      const entry: CellEntry<Row> = {
        slotId: node.getAttribute('slot') ?? '',
        node,
        renderer,
        rendererFactory: column.renderer,
        rowKey,
        colId: column.id,
      };

      renderer.mount({node, row, value: context.value, colId: column.id});
      colMap.set(column.id, entry);
    }
  }

  private pruneRemoved(desiredKeys: ReadonlySet<string>): void {
    for (const [rowKey, colMap] of this.entries) {
      for (const [colId, entry] of colMap) {
        if (!desiredKeys.has(`${rowKey}\u0000${colId}`)) {
          entry.renderer.destroy();
          entry.node.remove();
          colMap.delete(colId);
        }
      }

      if (colMap.size === 0) {
        this.entries.delete(rowKey);
      }
    }
  }

  public getSlotId(rowKey: string, colId: string): string | undefined {
    return this.entries.get(rowKey)?.get(colId)?.slotId;
  }

  public drain(): void {
    for (const colMap of this.entries.values()) {
      for (const entry of colMap.values()) {
        entry.renderer.destroy();
        entry.node.remove();
      }
    }

    this.entries.clear();
  }
}
