# `<mndw-table>`

The table lists six connected clients. Its viewport owns horizontal scrolling on narrow screens.

## Examples

<script setup lang="ts">
import {mountSorting, mountVisibility} from '../.vitepress/theme/ui-demos/table.js';
</script>

### Sorting

The two-way arrow marks sortable columns; Name and Traffic are sortable, Traffic starts descending, and clicking a
sortable header sorts then reverses it.

<UiScriptDemo :mount="mountSorting" />

### Column visibility

The gear button at the end of the header row opens the column menu; IP address, MAC address, and Traffic (MB) can be
hidden, while Name stays visible.

<UiScriptDemo :mount="mountVisibility" />

<<< ../.vitepress/theme/ui-demos/table.ts

## Reference

Assign `columns`, `rows`, and `rowKey` as properties. Build columns with the curried `column<Row>()` helper. A
column defines its `id`, `label`, `accessor`, and optional `sortable`, `kind`, alignment, `width`, `sticky`, and
`nowrap`. Built-in kinds are `text`, `number`, `badge`, and non-interactive `boolean`. Replace `rows` with a new array
reference when data changes. Complex values (`columns`, `rows`, `rowKey`, `selected`, `sort`, `hiddenColumns`,
`rowLabel`, and `labels`) are property-only. String and enum attributes are `row-key` (string form only),
`sort-mode`, `empty-label`, `caption`, `column-menu-panel-class`, `layout`, `min-width`, and `sticky-header`.

Use `caption` for a visible table caption. When a table has no visible caption, set `label` to give its inner
`<table>` an accessible name. If both are set, the caption names the table and `label` is omitted.

`rowKey` is required and resolves to a non-empty string for each row, using a field name or function. Empty or
duplicate keys and duplicate column ids drop offending rows or columns, show the `error` part with `role="alert"`,
and emit `mndwerror` once per changed set of violations. Sorting and selection are controlled: render `sort` and
`selected`, listen for `mndwsortchange` and `mndwselectionchange`, then write the event values back. The table also
emits `mndwrowreorder`, `mndwcolumnvisibilitychange`, and `mndwerror`; these events bubble and cross shadow
boundaries. Selection includes checkboxes and select-all. Row reordering supports drag and keyboard interaction.

Column visibility is controlled when `hiddenColumns` is defined, including when set to an empty array. Listen for
`mndwcolumnvisibilitychange` and write its `hidden` list back to `hiddenColumns`. When `hiddenColumns` is `undefined`,
the built-in menu owns visibility state and emits the same event as a notification. The menu opens portaled
`<mndw-column-menu>`; set `columnMenu` to `false` to hide its trigger. Since its panel is portaled, style it with the
global class named by `column-menu-panel-class`, not `::part()` selectors.

Expandable rows use `expandable`, `expandOn`, and `expandedRenderer`. Set `toggleCell` to `leading` or `trailing`, or
`toggleAfterColumn` to place the chevron beside a visible column. Column `width` applies to header and body cells;
selection and expand utility columns stay narrow. `Column.sticky: 'start'` pins a contiguous leading run of visible
data columns, and each pinned column needs a width. A non-leading or widthless sticky column stays unpinned, sets
`data-mndw-sticky-inactive="not-leading"` or `"missing-width"`, and emits one development warning. Selection, drag,
and expand utility columns pin before the data columns. Offsets use logical inline properties for RTL; pinned cells
assume a `--mndw-surface` background. With `reorderable`, the pinned drag column is clamped to `2.5rem`, a cosmetic
limitation. `Column.nowrap: true` prevents wrapping. `layout="auto"` uses `table-layout: auto` and
`width: max-content` for content sizing and horizontal scroll; virtualization keeps fixed layout and sets
`data-mndw-layout-inactive="virtual"`. `min-width` applies to the table and can force overflow. `sticky-header` makes
the header sticky; with pinned columns, the top-left cell sticks on both axes.

The table exposes parts `viewport`, `table`, `caption`, `header`, `header-cell`, `sort-indicator`, `row`, `cell`,
`select-cell`, `select-all`, `drag-handle`, `column-menu-trigger`, `empty`, and `error`. The viewport also has class
`mndw-table-viewport` and is the only horizontal scroll owner. Keep controls in a light-DOM sibling region named
`mndw-table-controls`; the class and part are stable hooks for host and framework consumers.

Rich cells use a `CellRenderer` with `mount`, `update`, and `destroy`, supplied through `column.renderer`. Renderers
mount into parked light-DOM nodes so plugin cell styles apply. The `@mndw/ui-svelte`, `@mndw/ui-vue`, and
`@mndw/ui-angular` adapters render on mount/update and unmount on destroy. Host startup registers `@mndw/ui` before
plugins mount, so adapters do not wait for `customElements.whenDefined()`.

#### Dynamic virtualization

Set `virtual`, `estimatedRowHeight` (default `49`), and pixel `overscan` (default `400`) to render a bounded contiguous
window. The table keeps validation, sorting, selection, expansion, and `scrollToRow()` lookup over all rows.
`estimatedRowHeight` is a pre-measurement estimate; after four valid summary measurements, their running mean replaces
it for the current width epoch. `overscan={0}` is valid; invalid tuning uses defaults without creating row errors.
Attributes are `estimated-row-height` and `overscan`.

Virtual mode needs a bounded viewport for bounded DOM work. It uses positive-height native spacer rows, direct `<tr>`
measurement, `ResizeObserver`, and keyed anchor correction. The viewport owns scrolling and enforces
`overflow-anchor: none`, instant internal movement, and `scrollbar-gutter: stable`. Renderers outside the live window
are destroyed and mounted again when rows return, so data that must survive belongs in consumer state.
`scrollToRow(key, {align})` supports `start`, `center`, `end`, or `nearest` (default), returns `false` for an absent
valid key, and corrects deep estimated targets after measurement.
`virtual && reorderable` falls back to full rendering with `data-mndw-virtual-inactive="reorderable"`; missing
`ResizeObserver` reports `resize-observer-unavailable`. Both fallbacks keep logical table behavior.
