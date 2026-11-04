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

## Component catalog

Links point to plugins whose source currently uses each element. “No direct plugin use” means the
element is part of the package API but is not currently used directly by a plugin.

| Component | What it provides | Example plugin use |
| --- | --- | --- |
| `<mndw-select>` | Accessible select with slotted options and `mndwchange`. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget), [tx-rx-chart-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/tx-rx-chart-widget) |
| `<mndw-option>` | Declarative option value and rich label content for `<mndw-select>`. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget), [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-checkbox>` | Form-associated checkbox; emits `mndwchange`. | [device-info-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/device-info-widget), [clients-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/clients-widget) |
| `<mndw-button>` | Button with `primary`, `secondary`, `ghost`, and `danger` variants. | [ping-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/ping-widget), [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget) |
| `<mndw-scroll-area>` | Native scroll viewport with a bespoke scrollbar when content overflows. | No direct plugin use. |
| `<mndw-field>` | Light-DOM label, hint, and error wrapper for one control. | [ping-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/ping-widget), [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-input>` | Input with delegated focus; emits `mndwinput` and `mndwchange`. | [ping-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/ping-widget), [system-log-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/system-log-page) |
| `<mndw-textarea>` | Text area with optional autosizing; emits `mndwinput` and `mndwchange`. | No direct plugin use. |
| `<mndw-switch>` | Immediate-effect accessible switch; emits `mndwchange`. | [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-segmented>` | Radio group container for slotted `<mndw-segment>` choices. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget) |
| `<mndw-segment>` | One choice in a segmented group, with `value` and `disabled`. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget) |
| `<mndw-slider>` | Numeric range control; emits `mndwinput` and `mndwchange`. | [tx-rx-chart-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/tx-rx-chart-widget), [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-tabs>` | Tab container managing active value and child ARIA state. | [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-tab>` | One tab, identified by a required `id`; can be disabled. | [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-tab-panel>` | Panel associated with a tab through its `for` attribute. | [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-tooltip>` | Describes its first slotted element on hover and focus. | No direct plugin use. |
| `<mndw-line-chart>` | Timestamped multi-series line or area chart. | [cpu-temp-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/cpu-temp-widget), [tx-rx-chart-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/tx-rx-chart-widget) |
| `<mndw-bar-chart>` | Timestamped positional bar chart. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget) |
| `<mndw-sparkline>` | Compact percentage chart configured with `points`. | [device-info-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/device-info-widget), [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-heat-strip>` | Compact utilization heat strip configured with `points`. | [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-table>` | Data table with controlled sorting, selection, visibility, and custom cells. | [clients-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/clients-widget), [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page) |
| `<mndw-column-menu>` | Portaled column-visibility menu owned by `<mndw-table>`; do not open it directly. | Created internally by the table in [clients-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/clients-widget) and [mws-page](https://github.com/Eralde/mndw/tree/master/plugins/builtin/mws-page). |
| `<mndw-icon>` | Lucide icon from the host-provided shared sprite. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/master/plugins/examples/device-traffic-widget), [device-info-widget](https://github.com/Eralde/mndw/tree/master/plugins/builtin/device-info-widget) |

The catalog reflects current plugin source and can change as examples evolve. For exact contracts,
including chart/table property types and accessibility details, use the [package README](https://github.com/Eralde/mndw/blob/master/frontend/ui/README.md).
