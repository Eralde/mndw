# @mndw/ui-angular

Angular table cell adapters for mndw UI.

## Part of mndw

mndw is a modular web dashboard for Keenetic/Netcraze routers. Everything in it is a plugin: a dashboard widget or a full page. See [the plugin author site](https://eralde.github.io/mndw/).

## Install

`mndw create` adds this adapter to `dependencies` for Angular plugins. To add it by hand, install it in the plugin project; peer dependency: `@angular/core >=21.0.0`.

```sh
npm i @mndw/ui-angular
```

## Use

`@mndw/ui-angular` exports `MndwTableDirective`, `MndwCellDirective`, and `angularCell` for adapting Angular components or templates to the table cell lifecycle:

```ts
import {MndwCellDirective, MndwTableDirective} from '@mndw/ui-angular';
import {CUSTOM_ELEMENTS_SCHEMA, Component} from '@angular/core';
import {type Column, column} from '@mndw/ui';

interface TableRow {
  id: string;
  name: string;
}

function isTableRow(value: unknown): value is TableRow {
  return typeof value === 'object' && value !== null && 'id' in value && 'name' in value
    && typeof value.id === 'string' && typeof value.name === 'string';
}

@Component({
  standalone: true,
  imports: [MndwTableDirective, MndwCellDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <mndw-table [columns]="columns" [rows]="rows">
      <ng-template mndwCell="name" let-row>
        <span>{{ $any(row).name }}</span>
      </ng-template>
    </mndw-table>
  `,
})
export class TableComponent {
  protected readonly rows: readonly TableRow[] = [{id: 'first', name: 'Alpha'}];
  protected readonly columns: Column<unknown>[] = [
    column<unknown>()({
      id: 'name',
      label: 'Name',
      accessor: (row) => isTableRow(row) ? row.name : '',
    }),
  ];
}
```

## Read on

See the [table adapter guide](https://eralde.github.io/mndw/guides/ui-components#angular) and [UI components overview](https://eralde.github.io/mndw/ui/).
