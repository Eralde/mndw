# @mndw/ui

Framework-agnostic custom elements for mndw plugins and host pages. Components read the
`--mndw-*` design tokens published by the host; this package does not import `tokens.css`.

## Registration

The host is the sole registrar because `customElements.define` is page-global.

```ts
import {defineMndwUi} from '@mndw/ui';

defineMndwUi({overlay: uiOverlayService});
```

Plugins use elements directly. `@mndw/ui` is a shared dependency and is external at pack time.
Without an overlay, `<mndw-select>` uses a minimal fixed-position fallback for standalone use.

## Elements

| Element | Notes |
|---|---|
| `<mndw-select>` | Slotted `<mndw-option>` children. Emits `mndwchange`. |
| `<mndw-option>` | Declarative option data and rich label content; announces mutations. |
| `<mndw-checkbox>` | Emits `mndwchange`; form-associated with `name`, `value`, `required`, and `invalid`. |
| `<mndw-button>` | `variant="primary"`, `"secondary"`, `"ghost"`, or `"danger"`; `type="button"`, `"submit"`, or `"reset"`. |
| `<mndw-scroll-area>` | Native viewport with an always-visible bespoke scrollbar when content overflows. |
| `<mndw-field>` | Light-DOM label/hint/error wrapper for a single control. Renders no shadow root. |
| `<mndw-input>` | Native inner `<input>` with delegated focus. Emits `mndwinput` and `mndwchange`. |
| `<mndw-textarea>` | Native inner `<textarea>`; `rows` sizing with opt-in `autosize`. Same events. |
| `<mndw-switch>` | `role="switch"` on the host; immediate-effect toggle. Emits `mndwchange`. |
| `<mndw-segmented>` | `role="radiogroup"` with slotted `<mndw-segment>` children. Emits `mndwchange`. |
| `<mndw-segment>` | One choice in a segmented group; `value` and `disabled` only. |
| `<mndw-slider>` | `role="slider"` on the host; numeric range with pointer drag. Emits `mndwinput` and `mndwchange`. |
| `<mndw-tabs>` | Container owning an internal `tablist`, the active `value`, and its children's ARIA. Emits `mndwchange`. |
| `<mndw-tab>` | One tab; `id` (required) and `disabled` only. |
| `<mndw-tab-panel>` | Content for one tab; `for` points at that tab's `id`. |
| `<mndw-tooltip>` | Describes its first slotted element on hover and focus. Not form-associated. |
| `<mndw-line-chart>` | Timestamped multi-series line/area chart; data is assigned through properties. |
| `<mndw-bar-chart>` | Timestamped positional bar chart; data is assigned through properties. |
| `<mndw-table>` | Framework-neutral data table; `columns`/`rows` as properties, controlled sort/selection/visibility, custom light-DOM cell renderers. |
| `<mndw-column-menu>` | Portaled ARIA `menu` column-visibility panel owned by `<mndw-table>`; not opened directly. |

`<mndw-select>` uses an anchored popover above `600px`, with its maximum height derived from
available viewport space. Long desktop lists scroll inside the panel's nested native scroll area;
the panel owns border, radius, background, shadow, clipping, and a stable scrollbar gutter. At
`<=600px`, it opens a full-width bottom sheet sized to its content up to the viewport, with
title/close chrome, backdrop, scroll lock, and a scrolling option region when the list is long.
Sheet mode sizes panel to content up to viewport; nested option region owns scrolling. Sheet title
comes from `label`, falling back to `Select option`.

Breakpoint is evaluated from `window.innerWidth` when opening. Resizing across `600px` does not
morph an open layer; close and reopen to use the new presentation. Host focus containment is not
implemented for sheets; pressing `Tab` dismisses the panel and restores focus to the trigger.

Events are lowercase and hyphen-free (`mndwchange`) for vanilla, Svelte, Vue, and Angular.

### Charts

Charts accept normalized epoch-millisecond data. Assign arrays and objects as DOM properties;
they are not serialized into attributes:

```ts
import type {MndwChartSeries} from '@mndw/ui';

const series: MndwChartSeries[] = [
  {
    id: 'upload',
    label: 'Upload',
    color: 'accent',
    fill: true,
    data: [
      {time: 1_700_000_000_000, value: 100},
      {time: 1_700_000_060_000, value: 200},
    ],
  },
];

const line = document.querySelector('mndw-line-chart') as HTMLElement & {
  series: readonly MndwChartSeries[];
};
line.series = series;
```

`<mndw-line-chart>` exposes `series`, optional `domain`, and `emptyLabel`. The line domain is
property-only. `<mndw-bar-chart>` exposes `points`, `emptyLabel`, and `valueLabel`; it uses
positional band slots and has no time-domain property. String attributes use explicit hyphenated
names: `empty-label="No data"` and `value-label="Throughput"`.

Both charts use network-speed formatting and expose `container`, `plot`, `grid`, `axis`, `tooltip`,
and `empty` parts. Line colors map to `accent`, `success`, `warning`, or `muted`. Bars always use
`--mndw-accent` in version 1. Tooltips are local to the plot; data redraw clears stale tooltip
state and does not replay it until the pointer moves again.

Both hosts have `role="img"`. An authored `aria-label` wins. Otherwise line labels use each
series' `label` or `id`, while bar labels use `value-label` or neutral `Values`; empty charts use
`empty-label`. These fallbacks never assume plugin-specific vocabulary. `formatSpeed` is exported
for consumers that need matching text outside a chart, such as a plugin-owned summary.

`<mndw-checkbox>` and `<mndw-select>` participate in form submission through `ElementInternals`.
Unchecked checkboxes and empty or unmatched selects are omitted from `FormData`. Both controls
restore authored defaults on form reset and compose with `<fieldset disabled>`. Their roles and
focus targets live on the host, so external `<label for>` elements work as expected.

### `<mndw-table>`

The shared framework-neutral data table. Plugins declare `columns` (via the curried `column<Row>()`
builder) and assign `rows` as a new array reference on each update; the table owns sorting, checkbox
selection with select-all, row drag/keyboard reorder, and uniform column show/hide. Complex values
(`columns`, `rows`, `rowKey`, `selected`, `sort`, `hiddenColumns`, `rowLabel`, `labels`) are property-only;
the string/enum fields use explicit kebab-case attributes: `row-key` (string form only), `sort-mode`,
`empty-label`, `caption`, and `column-menu-panel-class`.

```ts
import {column} from '@mndw/ui';

interface NodeRow { id: string; node: { name: string; ip: string; clients: number }; }

const columns = [
  column<NodeRow>()({ id: 'name', label: 'Name', accessor: (row) => row.node.name, sortable: true }),
  column<NodeRow>()({ id: 'ip', label: 'IP', accessor: (row) => row.node.ip }),
  column<NodeRow>()({ id: 'clients', label: 'Clients', accessor: (row) => row.node.clients, kind: 'number', sortable: true }),
];

const table = document.querySelector('mndw-table');
table.rowKey = 'id';
table.columns = columns;
table.rows = nodeRows;
table.sort = { columnId: 'name', direction: 'asc' };
```

Sort and selection are controlled: the table renders from `sort` and `selected` and emits
`mndwsortchange` / `mndwselectionchange` / `mndwrowreorder` / `mndwcolumnvisibilitychange` /
`mndwerror` (all `{ bubbles: true, composed: true }`); the plugin writes the prop back. Column
visibility supports both modes: with `hiddenColumns` it is controlled; without it the built-in
column menu (the portaled `<mndw-column-menu>`) drives `internalHidden` and still emits
`mndwcolumnvisibilitychange` informationally. `columnMenu={false}` suppresses the menu.

`rowKey` is required and resolves to a non-empty string per row (a field name or
`(row) => string`). Empty or duplicate keys and duplicate column ids drop the offending rows/columns,
render a visible `error` part with `role="alert"`, and emit `mndwerror` once per violation-set change.

Expandable tables render a controlled inline detail row with `expandable`, `expandOn`, and
`expandedRenderer`. Set `toggleCell` to `leading` or `trailing` for utility-column placement, or set
`toggleAfterColumn` to a visible column id to place its chevron beside that column. Column `width`
values apply to their header and body cells; selection and expand utility columns stay narrow.

#### Dynamic virtualization

Set `virtual`, `estimatedRowHeight` (default `49`), and pixel `overscan` (default `400`) to render a
bounded contiguous window while keeping validation, sorting, selection, expansion, and
`scrollToRow()` lookup over the complete `rows` array. `estimatedRowHeight` is a pre-measurement
estimate only; after four valid summary measurements, the running mean replaces it for the current
width epoch. `overscan={0}` is valid. Invalid tuning values use defaults and do not create data
violations. Numeric attributes are `estimated-row-height` and `overscan`.

Virtual mode requires a bounded viewport for bounded DOM work. It uses native positive-height
`virtual-spacer` rows, direct `<tr>` measurement, keyed anchor correction, and `ResizeObserver`.
Custom-cell renderers outside the live window are destroyed; scrolling them back mounts fresh
instances. Keep data needed across that boundary in consumer state. The viewport owns scrolling and
enforces `overflow-anchor: none`, instant internal movement, and `scrollbar-gutter: stable`.

`scrollToRow(key, {align})` accepts `start`, `center`, `end`, or `nearest` (default). It returns
`false` for an absent valid key and otherwise returns `true`; deep unmeasured targets first land on
estimates and then correct after measurement. `virtual && reorderable` falls back to full rendering
and exposes `data-mndw-virtual-inactive="reorderable"`. If `ResizeObserver` is unavailable, the
fallback reason is `resize-observer-unavailable`. Neither fallback changes logical behavior.

#### Framework adapters

Built-in `kind`s are `text`, `number`, `badge`, and a non-interactive `boolean` glyph. Rich cells use
a `CellRenderer` (`mount`/`update`/`destroy`), supplied through `column.renderer`, and render in a
parked light-DOM node so the plugin cell's scoped styles apply. Framework adapters
(`@mndw/ui-svelte`, `@mndw/ui-vue`, `@mndw/ui-angular`) turn native cells into renderers. Parts:
`viewport`, `table`, `caption`, `header`, `header-cell`, `sort-indicator`, `row`, `cell`, `select-cell`,
`select-all`, `drag-handle`, `column-menu-trigger`, `empty`, `error`. The menu panel is portaled, so it
is styled through `column-menu-panel-class`, not `mndw-table::part(...)`.

Adapters render into the parked node on mount/update and unmount on destroy; host startup registers
`@mndw/ui` before plugin mount, so they never wait on `customElements.whenDefined()`.

```ts
// Angular — mndwCell directive on an ng-template
column<NodeRow>()({id: 'name', label: 'Name', accessor: (r) => r.node.name, sortable: true})
// <ng-template mndwCell="name" [mndwCellRows]="rows()" let-row>{{ row.node.name }}</ng-template>
```

```svelte
<script lang="ts">
  import {svelteCell} from '@mndw/ui-svelte';
  import PackageNameCell from './PackageNameCell.svelte';
  export const nameCell = svelteCell<PackageEntry, string>()(PackageNameCell)();
</script>
```

```ts
// Vue — defineComponent or functional component
import {vueCell} from '@mndw/ui-vue';
import ClientNameCell from './ClientNameCell.vue';
const nameCell = vueCell<ClientRecord, string>()(ClientNameCell)();
```

### `<mndw-field>`

Field takes the control as a light-DOM child and wires labelling itself. It renders into light DOM,
so it exposes classes rather than `::part()`:

```html
<mndw-field label="Host name" hint="Shown in the device list." error="" required>
  <input name="hostname" />
</mndw-field>
```

Properties are `label`, `hint`, `error`, and `required`; each is a string except `required`, and an
empty string hides its node instead of rendering it blank. Field creates exactly three nodes once —
`label.mndw-field__label`, `.mndw-field__hint`, and `.mndw-field__error` (which carries
`role="alert"` and the `.mndw-alert--danger` classes) — and places them around the control in label,
control, hint, error order. The control is the first child that is an `Element`, so comments,
placeholder nodes, and whitespace are skipped, and replacing the control rewires automatically.

Field owns only what it writes. It generates an `id` on the control when it has none, points its
`<label for>` at that id, appends its hint/error ids to `aria-describedby`, sets `aria-invalid` while
`error` is non-empty, and mirrors `required`. Consumer-supplied ids, describedby tokens, and prior
attribute values are preserved and restored; a control that is not labelable is named through
`aria-labelledby` pointing at field's own label instead.

**The control's own name always wins.** Field renders no label when the control has a non-empty
`aria-label`, an `aria-labelledby` pointing outside field, a consumer `<label for>` anywhere in the
same tree, or its own declared label source. A control declares that source as a static
`mndwLabelSource`: `<mndw-checkbox>` uses `'slot'` (its slotted content is the name) and
`<mndw-select>` uses `'label-property'` (its `label` property is the name). Controls whose label
source can change after mount dispatch `mndwlabelchange` (`bubbles`, `composed`) so field rewires.

### `<mndw-input>`

A text control: the host owns form participation, and a real native `<input>` inside the shadow root
owns editing, caret, selection, IME, and masking. The shadow root uses `delegatesFocus`, so a
`<label for>` click or `.focus()` lands on the native element.

```html
<mndw-field label="Listen port" hint="1–65535">
  <mndw-input type="number" name="port" min="1" max="65535" step="1">
    <span slot="suffix">s</span>
  </mndw-input>
</mndw-field>
```

Properties are `value`, `type` (`text | password | search | number | url`, default `text`;
anything else falls back to `text`), `placeholder`, `readonly`, `min`, `max`, `step`, `maxlength`,
`autocomplete`, plus the shared `name`, `disabled`, `required`, and `invalid`. `value` is state, so
it does **not** reflect — the `value` attribute stays the authored default that form reset restores.
Parts are `field`, `input`, `prefix`, and `suffix`; `prefix` and `suffix` are slots for adornments.

Events are `mndwinput` on every keystroke and `mndwchange` on commit, both with
`detail: {value: string}`. Commit means blur or Enter, and only when the value differs from what it
was when the control gained focus; Enter resets that baseline so the following blur does not fire a
second event. A programmatic write emits nothing and replaces the baseline, so framework bindings
that write `value` back on render cannot loop.

Because the announced element lives in the shadow root, the control forwards what names and
describes it: `aria-labelledby` (resolved to text), else `aria-label`, else the text of its
associated `<label>` elements becomes the inner element's `aria-label`; `aria-describedby` becomes
its `aria-description`; and `aria-invalid` — from the host attribute, else the `invalid` property,
else computed constraint validity — is mirrored too. The host keeps its own attributes; only the
resolved copies move inward. Resolution reads `textContent` minus `aria-hidden` subtrees, so
decorative content such as `<mndw-field>`'s required marker is never announced, while text hidden
only by CSS still contributes — the same rules the platform applies to a native input.
Re-resolution runs when those host attributes change and when
referenced text is edited. A `<label for>` inserted, removed, or re-pointed elsewhere in the tree is
the one case nothing observes: call `refreshAccessibleName()` for it, as `<mndw-field>` does.

Validation delegates to the platform. `type`, `required`, `min`, `max`, `step`, and `maxlength` live
on the native element, and the host mirrors its `validity` and `validationMessage` through
`ElementInternals`, so the form sees the same result a native `<input>` would produce.

### `<mndw-textarea>`

The same text-family control as `<mndw-input>`, wrapping a native `<textarea>`. It shares the
forwarding rules, form participation, and commit condition described above; what differs is the
inner element and three things that follow from it.

```html
<mndw-field label="Release notes" hint="Markdown is supported.">
  <mndw-textarea name="notes" rows="5" maxlength="2000"></mndw-textarea>
</mndw-field>
```

Properties are `value`, `rows` (default `3`), `autosize` (default `false`), `readonly`, and
`maxlength`, plus the shared `name`, `disabled`, `required`, and `invalid`. Parts are `field` and
`textarea`.

**Enter does not commit.** It inserts a newline, as in a native `<textarea>`, so `mndwchange` fires
on blur only — still just when the value differs from what it was at focus. `mndwinput` is unchanged.

**`autosize` is opt-in** because it costs a `ResizeObserver`: the height has to be recomputed when
the width changes and the text reflows, not only when the value changes. While it is on, the control
drives the inner element's height from its content and drops `rows`, since a row count would fight
it; turning it off restores `rows` sizing and clears the inline height.

### `<mndw-switch>`

An immediate-effect toggle. It differs from `<mndw-checkbox>` by semantics rather than styling: a
switch applies its change at once, a checkbox travels with a form submission. The host's dark-theme
setting is a switch; package selection is a checkbox.

```html
<mndw-field label="Dark theme">
  <mndw-switch name="theme" value="dark"></mndw-switch>
</mndw-field>
```

Properties are `checked` and `value` (default `'on'`), plus the shared `name`, `disabled`,
`required`, and `invalid`. Both `checked` and `value` reflect — `value` is configuration, the token
submitted while the switch is on. Parts are `track`, `thumb`, and `label`. `mndwchange` carries
`detail: {checked: boolean}` and fires on user activation only, never on a programmatic write.

The host carries `role="switch"`, the tab stop, and the keyboard handling; Space and Enter toggle,
and the shadow track and thumb are presentational and `aria-hidden`. `FormData` gets `value` while
checked and nothing at all while unchecked, and form reset restores the `checked` **attribute**.

**`required` is accepted and inert**, as it is on a native `<input type="range">`: a switch always
holds a value, so `valueMissing` can never be true. It sets no validity flag and no `aria-required`.
`invalid` reflects for styling; `<mndw-field>` owns the `aria-invalid` announcement.

The accessible name comes from outside: a `<label for>` on the host, or `<mndw-field>`. Slotted
content renders in the `label` part for standalone use, but a switch declares no `mndwLabelSource`,
so a wrapping field always renders its own label rather than deferring to that content.

### `<mndw-segmented>` and `<mndw-segment>`

A radio group in segmented-control clothing, following the `<mndw-select>` / `<mndw-option>` idiom:
the group owns the value, the events, and the form state; the children are declarative.

```html
<mndw-segmented label="Range" name="range" value="day">
  <mndw-segment value="day">Day</mndw-segment>
  <mndw-segment value="week">Week</mndw-segment>
  <mndw-segment value="month" disabled>Month</mndw-segment>
</mndw-segmented>
```

The group carries `value`, the author-facing `label`, and the shared `name`, `disabled`,
`required`, and `invalid`; `value` is state and does not reflect. Part `group`. `mndwchange` carries
`detail: {value: string}` and fires on user activation only. Each `<mndw-segment>` carries just
`value` (required, reflected) and `disabled` (reflected), with content in its default slot and part
`segment`. A segment with no `value` is ignored rather than treated as an error.

`role="radiogroup"` sits on the group and `role="radio"` on each segment, written by the group along
with `aria-checked`, `aria-disabled`, and the roving `tabindex` — and removed again from any segment
that leaves the group. **The tab stop is the checked segment**, or the first enabled one when
nothing is checked; the group host stays at `tabindex="-1"` so `form.reportValidity()` has an anchor
without Tab ever landing on it. Arrow keys move and select with wraparound, Home and End jump to the
first and last enabled segment, Space and Enter select the focused one, and disabled segments are
skipped throughout.

Nothing selected is a valid initial state: `FormData` omits the group entirely, and `required`
reports `valueMissing` only while the value matches no segment. Reset restores the `value`
**attribute**, or clears the selection when none was authored. The `label` property is the group's
accessible name — it has no slotted text to take one from — so it declares
`mndwLabelSource = 'label-property'` and emits `mndwlabelchange` when it changes, which is what lets
a wrapping `<mndw-field>` decide whether to render its own label.

### `<mndw-slider>`

A numeric range control. The host is the slider: it carries `role="slider"`, the tab stop, the
keyboard matrix, and the pointer drag, while the track, fill, thumb, and output inside the shadow
root are presentational.

```html
<mndw-field label="Transmit power">
  <mndw-slider name="power" min="0" max="20" step="5" value="10" value-text="10 dBm"></mndw-slider>
</mndw-field>
```

Properties are `value`, `min`, `max`, and `step` (all `number`, defaults `0`, `100`, `1`, with
`value` defaulting to `min`), `valueText` (attribute `value-text`), plus the shared `name`,
`disabled`, `required`, and `invalid`. `min`, `max`, and `step` reflect because they are
configuration; `value` is state and does not, so the `value` attribute stays the default that form
reset restores. Parts are `track`, `fill`, `thumb`, and `output`.

**`value` is a `number` end to end.** Both events carry `detail: {value: number}`, and only the form
value is stringified — `FormData` always contains the slider's `name`, since a slider always holds a
value. Every write is clamped into range and snapped onto the step grid measured from `min`, so a
value that arrives out of range or off-grid is corrected rather than rejected. An empty `valueText`
leaves `aria-valuetext` unset so the browser announces `aria-valuenow`; a non-empty one is announced
instead and is also what the `output` part shows.

`mndwinput` fires on every pointer move or keystroke that moves the value. `mndwchange` commits:
once on `pointerup` or `pointercancel`, and only when the value differs from what it was at
`pointerdown`; on the keyboard it fires immediately after each `mndwinput`, on the same keystroke,
as a native `<input type="range">` does. Neither fires for a programmatic write.

Arrow keys step, PageUp and PageDown jump a tenth of the range (never less than one step), and Home
and End go to `min` and `max`. **`required` is accepted and inert**, as on `<mndw-switch>`;
`rangeUnderflow`, `rangeOverflow`, and `stepMismatch` are computed by the control, which normally
means no flag at all — normalization keeps the value legal, so they surface a contradictory
configuration such as a `min` above `max`. The accessible name comes from outside: a `<label for>`
on the host, or `<mndw-field>`.

### `<mndw-tabs>`, `<mndw-tab>`, and `<mndw-tab-panel>`

Three elements, one relationship. The group owns the active `value`, the keyboard matrix, and every
ARIA attribute on its children; the children are declarative.

```html
<mndw-tabs value="network">
  <mndw-tab id="general">General</mndw-tab>
  <mndw-tab id="network">Network</mndw-tab>
  <mndw-tab id="advanced" disabled>Advanced</mndw-tab>
  <mndw-tab-panel for="general">General settings</mndw-tab-panel>
  <mndw-tab-panel for="network">Network settings</mndw-tab-panel>
</mndw-tabs>
```

`<mndw-tabs>` carries `value` — the active tab's `id`, state, so it does not reflect — and part
`tablist`. It has **no role of its own**: making the group a `tablist` would wrongly include the
panels, so the role sits on an internal wrapper that only the tabs are slotted into. `mndwchange`
carries `detail: {value: string}` and fires on user activation only. Not form-associated; tab
selection is view state, not form data.

`<mndw-tab>` carries `id` (required) and `disabled`, with part `tab`. `<mndw-tab-panel>` carries
`for` — its tab's id — plus a generated `mndw-tab-panel-N` id when the consumer supplies none, and
part `panel`. **The panel points at its tab, not the other way round**, mirroring the ARIA
relationship and letting tabs be reordered or conditionally rendered without every reference
breaking; a `for` on a `<mndw-tab>` gets a `console.warn` naming the right element.

The group writes `role`, `aria-selected`, `aria-controls`, `aria-disabled`, the roving `tabindex`,
and `slot="tab"` onto its tabs, and `role`, `aria-labelledby`, and `hidden` onto its panels — and
removes exactly those again when a child leaves or the group disconnects. It rewires when a tab `id`,
a panel `for`, or the child order changes. Activation is **automatic**: arrow keys move focus and
selection together with wraparound, Home and End jump to the first and last enabled tab, and disabled
tabs are skipped. An inactive panel is `hidden` rather than unmounted, so its content leaves the
accessibility tree and the tab order while keeping its state.

Malformed markup degrades rather than throws, each case reported once: a panel whose `for` matches no
tab stays hidden, a tab with no `id` renders inert (it can be neither referenced nor selected), and
when two panels claim one tab the first in document order wins.

### `<mndw-tooltip>`

Wraps a trigger and describes it. Properties are `text`, `placement` (`top | bottom | left | right`,
default `top`), and `delay` (ms before showing, default `500`; hiding is immediate). Part `tooltip`.

```html
<mndw-tooltip text="Restarts the device immediately" placement="bottom">
  <mndw-button variant="danger">Restart</mndw-button>
</mndw-tooltip>
```

The first assigned element in the default slot is the trigger; anything after it is ignored and
warned about once. Shows on hover and focus after `delay`, hides on pointer leave, blur, and Escape —
Escape is not consumed, so a dialog behind the tooltip still sees it. An empty `text` renders nothing,
carries no role, and describes nothing rather than showing an empty bubble.

**The host carries `role="tooltip"` and the id, not the bubble.** An `aria-describedby` token cannot
cross into a shadow root, so the described element has to be the host — which means the trigger sits
inside the described subtree and a screen reader announces the trigger's own name first, then this
text. The component appends only its own id token to the trigger's `aria-describedby`, preserving
every consumer token, and removes only that token when `text` empties, the trigger is replaced, the
host id changes, or the tooltip disconnects. It rewires when any of those change, including a
consumer rewriting `aria-describedby` underneath it.

The closed bubble is invisible but **not** removed: the description resolves from its text, so
`display: none` or `hidden` would leave the trigger describing nothing. Positioning comes from the
same shared module `<mndw-select>` uses, exported as `computeTooltipCoords`; the tooltip centres on
the requested side, flips when that side is clipped, clamps the cross axis into the viewport, and
publishes the side it settled on as `data-placement` for styling.

`<mndw-button>` uses `ElementInternals` only to reach its containing form: `type="submit"` calls
`requestSubmit()` and `type="reset"` calls `reset()`. It contributes no name/value pair and is not
a native submitter; use a native `<button>` when submitter data is required.

`variant` is `primary`, `secondary`, `ghost`, or `danger`, and the default stays `secondary`.
`danger` is for destructive actions — deleting a plugin, forgetting a device — and renders as a
`--mndw-danger-bg` tint with `--mndw-danger` text and border, deepening slightly on hover. It is
deliberately **not** a solid danger fill: the palette models `danger` as a foreground and emits no
contrast pair for it, so a solid fill would be a colour combination the generator never validated.

## Styling

Components consume inherited `--mndw-*` tokens. Use `::part()` for component styling. Select
panels are portaled, so `panel-class` must be global and is applied to the overlay layer wrapper:

```html
<mndw-select panel-class="tx-rx-iface-panel"></mndw-select>
```

```css
.tx-rx-iface-panel mndw-select-panel::part(option) { padding: 10px; }
.tx-rx-iface-panel mndw-select-panel::part(listbox) { padding-inline-end: 20px; }
.tx-rx-iface-panel mndw-select-panel::part(thumb) { background: var(--mndw-accent); }
```

### Global class layer

Host pages import `@mndw/sdk/tokens.css` and `@mndw/ui/styles.css` once. The class layer styles
light-DOM content without registering elements:

```html
<div class="mndw-alert mndw-alert--danger" role="alert">
  <div class="mndw-alert__title">Connection failed</div>
  <div class="mndw-alert__body">Retry request.</div>
</div>
<span class="mndw-badge mndw-badge--success">Connected</span>
<span class="mndw-status-dot mndw-status-dot--success" aria-hidden="true"></span>
<span class="mndw-spinner" aria-hidden="true"></span>
<div class="mndw-progress" role="progressbar" aria-busy="true"></div>
```

Alerts, badges, and status dots support `--danger`, `--success`, `--warning`, and `--info`
modifiers. `.mndw-empty`, `.mndw-card`, and `.mndw-toolbar` are semantic containers; consumers
own headings, roles, names, and live-region semantics. `.mndw-spinner` and `.mndw-progress` add
no roles. Use native `[hidden]` for visibility and attributes such as `[aria-busy]` for runtime
state.

Fields use `.mndw-field` with `.mndw-field__label`, `.mndw-field__hint`, and
`.mndw-field__error`. Consumer owns control IDs and `aria-describedby`/`aria-invalid` wiring;
error content carries `role="alert"` when it interrupts the user. `<mndw-field>` applies the same
classes to itself and its owned nodes, and does that wiring for you.

Tables use `.mndw-table` with normal `caption`, `thead`, `tbody`, `tr`, `th`, and `td` markup.
Add `.mndw-table--sticky-head` to opt into a sticky header. Sort state is expressed with native
`aria-sort`; no runtime state classes are required.

The overlay wrapper owns width and height bounds; the panel owns its visual chrome, and the
nested `<mndw-scroll-area>` owns option scrolling. Its `viewport`, `scrollbar`, `track`, and
`thumb` parts are forwarded by the select panel. Use `refresh()` for content changes observers
cannot see, or `viewportElement` for direct native `scrollTop`/`scrollTo` access.

Scrollbar hooks are `--mndw-scrollbar-size`, `--mndw-scrollbar-thumb`,
`--mndw-scrollbar-thumb-hover`, `--mndw-scrollbar-track`, `--mndw-scrollbar-radius`, and
`--mndw-scrollbar-thumb-min-size` (default `24px`). Generator emits defaults; ancestor overrides
inherit correctly. Scrollbar chrome is `aria-hidden`; native viewport and listbox remain accessible
interaction surface.

When `ElementInternals.ariaControlsElements` is unavailable, the select omits `aria-controls`
because its panel is portaled into another node tree. Rich option child nodes are cloned into the
panel without HTML string interpolation.
Sheet chrome belongs to the host overlay and is not exposed through `::part()`.
