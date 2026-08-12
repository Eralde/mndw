import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  type OnDestroy,
  type OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';
import {DASH, formatRate, formatSpeed, formatUptime} from '../../format';
import {NodeTableColumnsStore, type OptionalNodeColumnId} from '../../services/node-table-columns.store';
import {TRANSLATOR} from '../../tokens';
import {
  type NodeQuickFilter,
  type NodeRow,
  type NodeSortDir,
  type NodeSortKey,
  buildNodeRows,
  filterNodeRows,
  reconcileNodeRows,
  sortNodeRows,
} from './node-rows';

type NodeColumnId = 'name' | OptionalNodeColumnId;

interface NodeColumn {
  id: NodeColumnId;
  labelKey: string;
  sortKey?: NodeSortKey;
}

const NODE_COLUMNS: readonly NodeColumn[] = [
  {id: 'name', labelKey: 'nodes.name', sortKey: 'name'},
  {id: 'clients', labelKey: 'nodes.clients', sortKey: 'clients'},
  {id: 'status', labelKey: 'nodes.status'},
  {id: 'uptime', labelKey: 'nodes.uptime', sortKey: 'uptime'},
  {id: 'ip', labelKey: 'nodes.ip', sortKey: 'ip'},
  {id: 'via', labelKey: 'nodes.via', sortKey: 'via'},
  {id: 'connection', labelKey: 'nodes.connection'},
  {id: 'firmware', labelKey: 'nodes.firmware', sortKey: 'firmware'},
];

@Component({
  selector: 'mws-nodes-table',
  standalone: true,
  templateUrl: './nodes-table.component.html',
  styleUrls: ['./nodes-table.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsNodesTableComponent implements OnDestroy, OnInit {
  private readonly translator = inject(TRANSLATOR);
  private readonly columnsStore = inject(NodeTableColumnsStore);
  private readonly allRowsState = signal<NodeRow[]>([]);
  private readonly rowsState = signal<NodeRow[]>([]);
  private projectionInitialized = false;

  public readonly roots = input.required<MwsNode[]>();
  public readonly quickFilter = input<NodeQuickFilter>('none');
  public readonly nodeActivated = output<string>();

  private readonly inputEffect = effect(() => {
    const nextRows = buildNodeRows(this.roots());
    const quickFilter = this.quickFilter();
    const previousRows = untracked(() => this.rowsState());
    const search = untracked(() => this.search());

    this.allRowsState.set(nextRows);

    if (!this.projectionInitialized) {
      this.rowsState.set(this.sortedRows(nextRows));
      this.projectionInitialized = true;

      return;
    }

    this.rowsState.set(reconcileNodeRows(previousRows, nextRows, search, quickFilter));
  });
  protected readonly search = signal('');
  protected readonly sortKey = signal<NodeSortKey>('name');
  protected readonly sortDir = signal<NodeSortDir>('asc');
  protected readonly settingsOpen = signal(false);
  protected readonly rows = this.rowsState.asReadonly();
  protected readonly allRows = this.allRowsState.asReadonly();
  protected readonly columns = NODE_COLUMNS;
  protected readonly visibleColumns = computed(() =>
    this.columns.filter((column) => column.id === 'name' || this.columnsStore.visibleColumns().has(column.id))
  );
  protected readonly dash = DASH;

  public ngOnInit(): void {
    void this.columnsStore.load();
  }

  public ngOnDestroy(): void {
    void this.columnsStore.flush();
  }

  protected onSearch(event: CustomEvent<{value?: string}>): void {
    this.search.set(event.detail.value ?? '');
    this.reproject();
  }

  protected onSort(key: NodeSortKey): void {
    if (key === this.sortKey()) {
      this.sortDir.update((dir) => dir === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    }

    this.reproject();
  }

  protected onColumnVisibility(id: OptionalNodeColumnId, event: CustomEvent<{checked?: boolean}>): void {
    const visible = event.detail.checked ?? false;

    this.columnsStore.setVisible(id, visible);

    if (!visible && id === this.sortKey()) {
      this.sortKey.set('name');
      this.sortDir.set('asc');
    }

    this.reproject();
  }

  protected isColumnVisible(id: OptionalNodeColumnId): boolean {
    return this.columnsStore.visibleColumns().has(id);
  }

  protected toggleSettings(): void {
    this.settingsOpen.update((open) => !open);
  }

  protected activateNode(id: string): void {
    this.nodeActivated.emit(id);
  }

  protected status(node: MwsNode): string {
    return node.isOnline ? this.t('nodes.online') : this.t('nodes.offline');
  }

  protected connection(node: MwsNode): string {
    const backhaul = node.backhaul;

    if (backhaul === null) {
      return DASH;
    }

    const wireless = backhaul.mode !== null
      || backhaul.txrate !== null
      || backhaul.rssi !== null
      || backhaul.security !== null;

    const values = wireless
      ? [formatRate(backhaul.txrate), backhaul.mode]
      : [formatSpeed(backhaul.speed), backhaul.duplex, backhaul.portLabel];
    const present = values.filter((value) => value !== null && value !== DASH);

    return present.length === 0 ? DASH : present.join(' · ');
  }

  protected uptime(node: MwsNode): string {
    return formatUptime(node.system?.uptime);
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  private sortedRows(rows: NodeRow[]): NodeRow[] {
    return sortNodeRows(
      filterNodeRows(rows, this.search(), this.quickFilter()),
      this.sortKey(),
      this.sortDir(),
    );
  }

  private reproject(): void {
    this.rowsState.set(this.sortedRows(this.allRowsState()));
  }
}
