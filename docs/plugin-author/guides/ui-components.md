# Shared UI components

`@mndw/ui` provides framework-independent custom elements for common controls, charts, and tables.
Use its components for controls it provides, so plugins share a consistent visual style and
interaction behavior. The host registers the elements once because `customElements.define` is
page-global. Plugins should not call `defineMndwUi()` themselves.

The plugin package uses `@mndw/ui` and a framework wrapper. The wrappers `@mndw/ui-svelte`,
`@mndw/ui-vue`, and `@mndw/ui-angular` come from npm. The scaffold already lists the packages for its
selected framework. The host provides the shared elements at runtime. Tests running in a DOM environment can
register the elements with `@mndw/ui/testing/setup`; see the [`hello-widget` test setup](https://github.com/Eralde/mndw/blob/master/plugins/examples/hello-widget/vitest.setup.ts).

Use custom elements directly in Svelte, Vue, Angular, or vanilla code. UI events use lowercase,
hyphen-free names such as `mndwinput` and `mndwchange`. Assign arrays and objects through DOM
properties rather than string attributes. The [`@mndw/ui` README](https://github.com/Eralde/mndw/blob/master/frontend/ui/README.md)
documents full properties, events, accessibility behavior, and styling hooks.

For example, the [Hello widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/hello-widget)
uses a shared button for its backend action:

```svelte
<mndw-button
  variant="primary"
  type="button"
  disabled={state === 'loading'}
  onclick={() => void loadGreeting()}
>
  {state === 'loading' ? 'Loading…' : 'Say hello'}
</mndw-button>
```

## Table cells

Each framework wrapper adapts a framework component into a table cell renderer. These examples follow
the Svelte and Vue scaffold tests and the Angular template path.

### Svelte

```svelte
<script lang="ts">
import {column} from '@mndw/ui';
import {svelteCell} from '@mndw/ui-svelte';
import TableNameCell from './TableNameCell.svelte';

interface TableRow {
  id: string;
  name: string;
}

const nameColumn = column<TableRow>()({
  id: 'name',
  label: 'Name',
  accessor: (row) => row.name,
  renderer: svelteCell<TableRow, string>()(TableNameCell),
});
</script>
```

### Vue

```vue
<script setup lang="ts">
import {column} from '@mndw/ui';
import {vueCell} from '@mndw/ui-vue';
import TableNameCell from './TableNameCell.vue';

interface TableRow {
  id: string;
  name: string;
}

const nameColumn = column<TableRow>()({
  id: 'name',
  label: 'Name',
  accessor: (row) => row.name,
  renderer: vueCell<TableRow, string>()(TableNameCell),
});
</script>
```

### Angular

Import `MndwTableDirective` and `MndwCellDirective` in the standalone component, then declare a cell
template by column ID:

```ts
import {CUSTOM_ELEMENTS_SCHEMA, Component} from '@angular/core';
import {MndwCellDirective, MndwTableDirective} from '@mndw/ui-angular';
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
export class TableExampleComponent {
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

For a reusable Angular cell component, `angularCell` adapts a component to the table renderer API.

See the [UI components](/ui/) section for the complete component catalog, interactive examples, and API reference.
