import {CUSTOM_ELEMENTS_SCHEMA, Component, type OnDestroy, computed, inject, input, signal} from '@angular/core';
import {type Column, type MndwSortChangeDetail, type SortState, column} from '@mndw/ui';
import {MndwCellDirective, MndwTableDirective} from '@mndw/ui-angular';
import type {MwsNode} from '../../domain/mws/mws.types';
import {TRANSLATOR} from '../../tokens';
import {compareIpStrings} from '../nodes-table/node-rows';
import {type ClientRow, type SortDir, type SortKey, buildClientRows, filterRows} from './clients-rows';

@Component({
  selector: 'mws-clients-table',
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  templateUrl: './clients-table.component.html',
  styleUrls: ['./clients-table.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsClientsTableComponent implements OnDestroy {
  private readonly translator = inject(TRANSLATOR);
  public readonly roots = input.required<MwsNode[]>();

  protected readonly search = signal('');
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly sortDir = signal<SortDir>('asc');

  protected readonly columns: Column<ClientRow>[] = [
    column<ClientRow>()({id: 'name', label: this.t('clients.name'), accessor: (row) => row.client.name,
      sortable: true}),
    column<ClientRow>()({id: 'node', label: this.t('clients.node'), accessor: (row) => row.node.name, sortable: true}),
    column<ClientRow>()({id: 'link', label: this.t('clients.link'), accessor: (row) => row.client.wired, sortable: true,
      comparator: (a, b) => Number(b) - Number(a)}),
    column<ClientRow>()({id: 'ip', label: this.t('clients.ip'), accessor: (row) => row.client.ip, sortable: true,
      comparator: (a, b) => compareIpStrings(a ?? '', b ?? '')}),
    column<ClientRow>()({id: 'mac', label: this.t('clients.mac'), accessor: (row) => row.client.mac, sortable: true}),
    column<ClientRow>()({id: 'uptime', label: this.t('clients.uptime'), accessor: (row) => row.client.uptime,
      kind: 'number', sortable: true}),
  ];

  protected readonly rowKey = (row: ClientRow): string => `${row.node.id}:${row.client.mac}`;
  protected readonly allRows = computed<ClientRow[]>(() => buildClientRows(this.roots()));
  protected readonly rows = computed<ClientRow[]>(() => filterRows(this.allRows(), this.search()));
  protected readonly sort = computed<SortState>(() => ({columnId: this.sortKey(), direction: this.sortDir()}));

  public ngOnDestroy(): void {}

  protected onSearch(event: CustomEvent<{value: string}>): void {
    this.search.set(event.detail.value);
  }

  protected onSortChange(event: CustomEvent<MndwSortChangeDetail>): void {
    const sort = event.detail.sort;

    if (sort === null) {
      this.sortKey.set('name');
      this.sortDir.set('asc');

      return;
    }

    this.sortKey.set(sort.columnId as SortKey);
    this.sortDir.set(sort.direction);
  }

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }
}
