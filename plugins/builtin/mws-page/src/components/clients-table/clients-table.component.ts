import {CUSTOM_ELEMENTS_SCHEMA, Component, type OnDestroy, computed, inject, input, signal} from '@angular/core';
import type {MwsNode} from '../../domain/mws/mws.types';
import {DASH, formatUptime} from '../../format';
import {TRANSLATOR} from '../../tokens';
import {type ClientRow, type SortDir, type SortKey, buildClientRows, filterRows, sortRows} from './clients-rows';

interface SortColumn {
  key: SortKey;
  labelKey: string;
}

@Component({
  selector: 'mws-clients-table',
  standalone: true,
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
  protected readonly allRows = computed<ClientRow[]>(() => buildClientRows(this.roots()));
  protected readonly rows = computed<ClientRow[]>(() =>
    sortRows(filterRows(this.allRows(), this.search()), this.sortKey(), this.sortDir())
  );
  protected readonly columns: SortColumn[] = [
    {key: 'name', labelKey: 'clients.name'},
    {key: 'node', labelKey: 'clients.node'},
    {key: 'link', labelKey: 'clients.link'},
    {key: 'ip', labelKey: 'clients.ip'},
    {key: 'mac', labelKey: 'clients.mac'},
    {key: 'uptime', labelKey: 'clients.uptime'},
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

  protected t(key: string, values?: Record<string, unknown>): string {
    return this.translator.t(key, values);
  }

  public ngOnDestroy(): void {
  }
}
