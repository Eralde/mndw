import {CUSTOM_ELEMENTS_SCHEMA, Component, Input, computed, signal} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';
import {DASH, formatUptime} from '../../format';
import {type ClientRow, type SortDir, type SortKey, buildClientRows, filterRows, sortRows} from './clients-rows';

interface SortColumn {
  key: SortKey;
  label: string;
}

@Component({
  selector: 'mws-clients-table',
  standalone: true,
  templateUrl: './clients-table.component.html',
  styleUrls: ['./clients-table.component.scss'],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class MwsClientsTableComponent {
  private readonly rootsState = signal<MwsNode[]>([]);

  @Input({required: true})
  public set roots(value: MwsNode[]) {
    this.rootsState.set(value);
  }

  public get roots(): MwsNode[] {
    return this.rootsState();
  }

  protected readonly search = signal('');
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly sortDir = signal<SortDir>('asc');
  protected readonly allRows = computed<ClientRow[]>(() => buildClientRows(this.rootsState()));
  protected readonly rows = computed<ClientRow[]>(() =>
    sortRows(filterRows(this.allRows(), this.search()), this.sortKey(), this.sortDir())
  );
  protected readonly columns: SortColumn[] = [
    {key: 'name', label: 'Name'},
    {key: 'node', label: 'Connected node'},
    {key: 'link', label: 'Link'},
    {key: 'ip', label: 'IP'},
    {key: 'mac', label: 'MAC'},
    {key: 'uptime', label: 'Uptime'},
  ];
  protected readonly dash = DASH;

  protected onSearch(event: CustomEvent<{value: string}>): void {
    this.search.set(event.detail.value);
  }

  protected onSort(key: SortKey): void {
    if (key === this.sortKey()) {
      this.sortDir.update((dir) => dir === 'asc' ? 'desc' : 'asc');

      return;
    }

    this.sortKey.set(key);
    this.sortDir.set('asc');
  }

  protected uptime(value: number | null): string {
    return formatUptime(value);
  }
}
