import {CUSTOM_ELEMENTS_SCHEMA, Component, signal} from '@angular/core';
import type {Column} from '@mndw/ui';
import {MndwCellDirective, MndwTableDirective} from '../src/index.js';

interface NodeRow {
  id: string;
  node: {name: string};
}

@Component({
  selector: 'strict-templates',
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <mndw-table [columns]="columns" [rows]="rows()" rowKey="id">
      <ng-template mndwCell="name" [mndwCellRows]="rows" let-row let-value="value" let-colId="colId">
        {{ row.node.name }} / {{ value }} / {{ colId }}
      </ng-template>
    </mndw-table>
  `,
})
export class StrictTemplatesComponent {
  public columns: Column<unknown>[] = [];
  public rows = signal<readonly NodeRow[]>([]);
}
