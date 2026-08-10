import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  EventEmitter,
  Input,
  type OnDestroy,
  type OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';
import {DASH, formatRate, formatSpeed, formatUptime} from '../../format';
import {NodeTableColumnsStore, type OptionalNodeColumnId} from '../../services/node-table-columns.store';
import {
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
  label: string;
  sortKey?: NodeSortKey;
}

const NODE_COLUMNS: readonly NodeColumn[] = [
  {id: 'name', label: 'Node name', sortKey: 'name'},
  {id: 'clients', label: 'Clients', sortKey: 'clients'},
  {id: 'status', label: 'Status'},
  {id: 'uptime', label: 'Uptime', sortKey: 'uptime'},
  {id: 'ip', label: 'IP address', sortKey: 'ip'},
  {id: 'via', label: 'Via', sortKey: 'via'},
  {id: 'connection', label: 'Connection'},
  {id: 'firmware', label: 'KeeneticOS', sortKey: 'firmware'},
];

@Component({
  selector: 'mws-nodes-table',
  standalone: true,
  templateUrl: './nodes-table.component.html',
  styleUrls: ['./nodes-table.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsNodesTableComponent implements OnDestroy, OnInit {
  private readonly columnsStore = inject(NodeTableColumnsStore);
  private readonly rootsState = signal<MwsNode[]>([]);
  private readonly allRowsState = signal<NodeRow[]>([]);
  private readonly rowsState = signal<NodeRow[]>([]);
  private projectionInitialized = false;

  @Input({required: true})
  public set roots(value: MwsNode[]) {
    const nextRows = buildNodeRows(value);

    this.rootsState.set(value);
    this.allRowsState.set(nextRows);

    if (!this.projectionInitialized) {
      this.rowsState.set(this.sortedRows(nextRows));
      this.projectionInitialized = true;

      return;
    }

    this.rowsState.set(reconcileNodeRows(this.rowsState(), nextRows, this.search()));
  }

  public get roots(): MwsNode[] {
    return this.rootsState();
  }

  @Output()
  public readonly nodeActivated = new EventEmitter<string>();
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
    return node.isOnline ? 'Online' : 'Offline';
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

  private sortedRows(rows: NodeRow[]): NodeRow[] {
    return sortNodeRows(filterNodeRows(rows, this.search()), this.sortKey(), this.sortDir());
  }

  private reproject(): void {
    this.rowsState.set(this.sortedRows(this.allRowsState()));
  }
}
