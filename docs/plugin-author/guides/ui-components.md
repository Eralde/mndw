# Shared UI components

`@mndw/ui` provides framework-independent custom elements for common controls, charts, and tables.
Use its components for controls it provides, so plugins share a consistent visual style and
interaction behavior. The host registers the elements once because `customElements.define` is
page-global. Plugins should not call `defineMndwUi()` themselves.

Add `@mndw/ui` to the plugin package when using these components. In workspace plugins, use the
workspace reference:

```json
{
  "devDependencies": {
    "@mndw/ui": "workspace:*"
  }
}
```

The host provides this package at runtime. Tests running in a DOM environment can register the
elements with `@mndw/ui/testing/setup`; see the [`hello-widget` test setup](https://github.com/Eralde/mndw/blob/main/plugins/examples/hello-widget/vitest.setup.ts).

Use custom elements directly in Svelte, Vue, Angular, or vanilla code. UI events use lowercase,
hyphen-free names such as `mndwinput` and `mndwchange`. Assign arrays and objects through DOM
properties rather than string attributes. The [`@mndw/ui` README](https://github.com/Eralde/mndw/blob/main/frontend/ui/README.md)
documents full properties, events, accessibility behavior, and styling hooks.

For example, the [Hello widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/hello-widget)
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

## Component catalog

Links point to plugins whose source currently uses each element. “No direct plugin use” means the
element is part of the package API but is not currently used directly by a plugin.

| Component | What it provides | Example plugin use |
| --- | --- | --- |
| `<mndw-select>` | Accessible select with slotted options and `mndwchange`. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget), [tx-rx-chart-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/tx-rx-chart-widget) |
| `<mndw-option>` | Declarative option value and rich label content for `<mndw-select>`. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget), [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-checkbox>` | Form-associated checkbox; emits `mndwchange`. | [device-info-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/device-info-widget), [clients-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/clients-widget) |
| `<mndw-button>` | Button with `primary`, `secondary`, `ghost`, and `danger` variants. | [ping-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/ping-widget), [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget) |
| `<mndw-scroll-area>` | Native scroll viewport with a bespoke scrollbar when content overflows. | No direct plugin use. |
| `<mndw-field>` | Light-DOM label, hint, and error wrapper for one control. | [ping-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/ping-widget), [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-input>` | Input with delegated focus; emits `mndwinput` and `mndwchange`. | [ping-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/ping-widget), [system-log-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/system-log-page) |
| `<mndw-textarea>` | Text area with optional autosizing; emits `mndwinput` and `mndwchange`. | No direct plugin use. |
| `<mndw-switch>` | Immediate-effect accessible switch; emits `mndwchange`. | [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-segmented>` | Radio group container for slotted `<mndw-segment>` choices. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget) |
| `<mndw-segment>` | One choice in a segmented group, with `value` and `disabled`. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget) |
| `<mndw-slider>` | Numeric range control; emits `mndwinput` and `mndwchange`. | [tx-rx-chart-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/tx-rx-chart-widget), [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-tabs>` | Tab container managing active value and child ARIA state. | [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-tab>` | One tab, identified by a required `id`; can be disabled. | [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-tab-panel>` | Panel associated with a tab through its `for` attribute. | [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-tooltip>` | Describes its first slotted element on hover and focus. | No direct plugin use. |
| `<mndw-line-chart>` | Timestamped multi-series line or area chart. | [cpu-temp-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/cpu-temp-widget), [tx-rx-chart-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/tx-rx-chart-widget) |
| `<mndw-bar-chart>` | Timestamped positional bar chart. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget) |
| `<mndw-sparkline>` | Compact percentage chart configured with `points`. | [device-info-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/device-info-widget), [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-heat-strip>` | Compact utilization heat strip configured with `points`. | [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-table>` | Data table with controlled sorting, selection, visibility, and custom cells. | [clients-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/clients-widget), [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page) |
| `<mndw-column-menu>` | Portaled column-visibility menu owned by `<mndw-table>`; do not open it directly. | Created internally by the table in [clients-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/clients-widget) and [mws-page](https://github.com/Eralde/mndw/tree/main/plugins/builtin/mws-page). |
| `<mndw-icon>` | Lucide icon from the host-provided shared sprite. | [device-traffic-widget](https://github.com/Eralde/mndw/tree/main/plugins/examples/device-traffic-widget), [device-info-widget](https://github.com/Eralde/mndw/tree/main/plugins/builtin/device-info-widget) |

The catalog reflects current plugin source and can change as examples evolve. For exact contracts,
including chart/table property types and accessibility details, use the [package README](https://github.com/Eralde/mndw/blob/main/frontend/ui/README.md).
