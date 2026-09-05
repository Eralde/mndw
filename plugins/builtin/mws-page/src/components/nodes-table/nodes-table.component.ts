import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  type OnDestroy,
  type OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  type Column,
  type MndwColumnVisibilityChangeDetail,
  type MndwSortChangeDetail,
  type SortState,
  column,
} from '@mndw/ui';
import {MndwCellDirective, MndwTableDirective} from '@mndw/ui-angular';
import type {MwsNode} from '../../domain/mws/mws.types';
import {DASH, formatRate, formatSpeed} from '../../format';
import {NodeTableColumnsStore, OPTIONAL_NODE_COLUMN_IDS} from '../../services/node-table-columns.store';
import {TRANSLATOR} from '../../tokens';
import {
  type NodeQuickFilter,
  type NodeRow,
  type NodeSortDir,
  type NodeSortKey,
  buildNodeRows,
  compareIpStrings,
  filterNodeRows,
} from './node-rows';

@Component({
  selector: 'mws-nodes-table',
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  templateUrl: './nodes-table.component.html',
  styleUrls: ['./nodes-table.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsNodesTableComponent implements OnDestroy, OnInit {
  private readonly translator = inject(TRANSLATOR);
  private readonly columnsStore = inject(NodeTableColumnsStore);

  public readonly roots = input.required<MwsNode[]>();
  public readonly quickFilter = input<NodeQuickFilter>('none');
  public readonly nodeActivated = output<string>();

  protected readonly search = signal('');
  protected readonly sortKey = signal<NodeSortKey>('name');
  protected readonly sortDir = signal<NodeSortDir>('asc');

  protected readonly columns = [
    column<NodeRow>()({
      id: 'name',
      label: this.t('nodes.name'),
      accessor: (row) => row.node.name,
      sortable: true,
      hideable: false,
      width: '300px',
      sticky: 'start',
    }),
    column<NodeRow>()({
      id: 'clients',
      label: this.t('nodes.clients'),
      accessor: (row) => row.node.clients.length,
      kind: 'number',
      sortable: true,
    }),
    column<NodeRow>()({
      id: 'status',
      label: this.t('nodes.status'),
      accessor: (row) => this.status(row.node),
    }),
    column<NodeRow>()({
      id: 'uptime',
      label: this.t('nodes.uptime'),
      accessor: (row) => row.node.system?.uptime ?? null,
      kind: 'number',
      sortable: true,
    }),
    column<NodeRow>()({
      id: 'ip',
      label: this.t('nodes.ip'),
      accessor: (row) => row.node.ip,
      sortable: true,
      comparator: (a, b) => compareIpStrings(a ?? '', b ?? ''),
    }),
    column<NodeRow>()({
      id: 'via',
      label: this.t('nodes.via'),
      accessor: (row) => row.node.parent?.node.name ?? null,
      sortable: true,
    }),
    column<NodeRow>()({
      id: 'connection',
      label: this.t('nodes.connection'),
      accessor: (row) => this.connection(row.node),
    }),
    column<NodeRow>()({
      id: 'firmware',
      label: this.t('nodes.firmware'),
      accessor: (row) => {
        const fw = row.node.fw;

        if (fw === null) {
          return null;
        }

        return row.node.fwUpdateAvailable && row.node.fwAvailable !== null && row.node.fwAvailable !== fw
          ? this.t('nodes.firmware-available', {current: fw, available: row.node.fwAvailable})
          : fw;
      },
      sortable: true,
    }),
    column<NodeRow>()({
      id: 'alert',
      label: this.t('nodes.alert'),
      accessor: (row) => row.node.fwUpdateAvailable ? this.t('nodes.update-available') : null,
    }),
  ] as Column<unknown>[];

  protected readonly allRows = computed(() => buildNodeRows(this.roots()));
  protected readonly rows = computed(() => filterNodeRows(this.allRows(), this.search(), this.quickFilter()));
  protected readonly hiddenColumns = computed(() =>
    OPTIONAL_NODE_COLUMN_IDS.filter((id) => !this.columnsStore.visibleColumns().has(id))
  );
  protected readonly sort = computed<SortState>(() => ({columnId: this.sortKey(), direction: this.sortDir()}));

  public ngOnInit(): void {
    void this.columnsStore.load();
  }

  public ngOnDestroy(): void {
    void this.columnsStore.flush();
  }

  protected onSearch(event: Event): void {
    this.search.set((event as CustomEvent<{value?: string}>).detail?.value ?? '');
  }

  protected onSortChange(event: Event): void {
    const sort = (event as CustomEvent<MndwSortChangeDetail>).detail.sort;

    if (sort === null) {
      this.sortKey.set('name');
      this.sortDir.set('asc');

      return;
    }

    this.sortKey.set(sort.columnId as NodeSortKey);
    this.sortDir.set(sort.direction);
  }

  protected onVisibilityChange(event: Event): void {
    const hidden = new Set((event as CustomEvent<MndwColumnVisibilityChangeDetail>).detail.hidden);

    for (const id of OPTIONAL_NODE_COLUMN_IDS) {
      const visible = !hidden.has(id);

      if (this.columnsStore.visibleColumns().has(id) !== visible) {
        this.columnsStore.setVisible(id, visible);
      }
    }

    if (this.sortKey() !== 'name' && hidden.has(this.sortKey())) {
      this.sortKey.set('name');
      this.sortDir.set('asc');
    }
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

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }
}
