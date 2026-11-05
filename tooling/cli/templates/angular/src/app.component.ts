import {CUSTOM_ELEMENTS_SCHEMA, Component, InjectionToken, computed, inject, input, signal} from '@angular/core';
import {toSignal} from '@angular/core/rxjs-interop';
import type {PluginContext} from '@mndw/sdk';
import {TRANSLATOR} from '@mndw/sdk/angular';
import {type Column, column} from '@mndw/ui';
import {MndwCellDirective, MndwTableDirective} from '@mndw/ui-angular';

interface TableRow {
  id: string;
  name: string;
}

function isTableRow(value: unknown): value is TableRow {
  return typeof value === 'object' && value !== null && 'id' in value && 'name' in value
    && typeof value.id === 'string' && typeof value.name === 'string';
}

export const PLUGIN_CONTEXT = new InjectionToken<PluginContext>('PLUGIN_CONTEXT');

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div [attr.data-theme]="theme()" style="padding:var(--mndw-space-4);font-family:sans-serif">
      <h3 data-testid="l10n-probe" data-plugin-label="__MNDW_LABEL__">{{ translator.t('l10n.probe') }}</h3>
      <p>Device: {{ deviceName() }}</p>
      <button (click)="count.set(count() + 1)">{{ translator.t('l10n.button') }} {{ count() }}</button>
      <p>{{ translator.t('l10n.result') }}</p>
      <mndw-table [columns]="columns()" [rows]="rows()" rowKey="id" [caption]="translator.t('table.caption')"
        [columnMenu]="false">
        <ng-template mndwCell="name" let-row>
          <span data-testid="table-name-cell">{{ $any(row).name }}</span>
        </ng-template>
      </mndw-table>
    </div>
  `,
})
export class AppComponent {
  private readonly ctx = inject(PLUGIN_CONTEXT);
  protected readonly translator = inject(TRANSLATOR);
  protected readonly theme = toSignal(this.ctx.theme$, {initialValue: this.ctx.theme});
  protected readonly rows = computed<readonly TableRow[]>(() => [
    {id: 'first', name: this.translator.t('table.first')},
    {id: 'second', name: this.translator.t('table.second')},
  ]);
  protected readonly columns = computed<Column<unknown>[]>(() => [
    column<unknown>()({
      id: 'name',
      label: this.translator.t('table.column'),
      accessor: (row) => isTableRow(row) ? row.name : '',
    }),
  ]);
  public readonly deviceName = input('');
  protected readonly count = signal(0);
}
