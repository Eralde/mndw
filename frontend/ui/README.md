# @mndw/ui

Framework-agnostic custom elements for mndw plugins and host pages.

## Part of mndw

mndw is a modular web dashboard for Keenetic/Netcraze routers. Everything in it is a plugin: a dashboard widget or a full page. See [the plugin author site](https://eralde.github.io/mndw/).

## Registration

The host calls `defineMndwUi()` once because custom element registration is page-global. Plugins use the tags directly;
`@mndw/ui` is a host-provided shared dependency and is externalized when packing. For standalone use, pass
`iconSpriteUrl` to `defineMndwUi` so `<mndw-icon>` can load the SVG sprite; see [icon setup](https://eralde.github.io/mndw/ui/icon).

## Components

| Component | Summary |
| --- | --- |
| [`<mndw-button>`](https://eralde.github.io/mndw/ui/button) | `variant` accepts `primary`, `secondary`, `ghost`, or `danger`; `type` accepts `button`, `submit`, or `reset`. |
| [`<mndw-icon>`](https://eralde.github.io/mndw/ui/icon) | Renders a Lucide symbol from the shared sprite; host supplies `iconSpriteUrl`. |
| [`<mndw-checkbox>`](https://eralde.github.io/mndw/ui/checkbox) | Form-associated checkbox; emits `mndwchange`. |
| [`<mndw-switch>`](https://eralde.github.io/mndw/ui/switch) | Immediate-effect toggle; emits `mndwchange`. |
| [`<mndw-input>`](https://eralde.github.io/mndw/ui/input) | Native input with delegated focus; emits `mndwinput` and `mndwchange`. |
| [`<mndw-textarea>`](https://eralde.github.io/mndw/ui/textarea) | Native textarea with optional autosize. |
| [`<mndw-field>`](https://eralde.github.io/mndw/ui/field) | Light-DOM label, hint, and error wrapper. |
| [`<mndw-select>`](https://eralde.github.io/mndw/ui/select) | Slotted `<mndw-option>` children; emits `mndwchange`. |
| [`<mndw-segmented>`](https://eralde.github.io/mndw/ui/segmented) | Radiogroup with slotted `<mndw-segment>` children. |
| [`<mndw-slider>`](https://eralde.github.io/mndw/ui/slider) | Numeric range with pointer drag. |
| [`<mndw-tabs>`](https://eralde.github.io/mndw/ui/tabs) | Owns tab selection and ARIA for `<mndw-tab>` and `<mndw-tab-panel>`. |
| [`<mndw-tooltip>`](https://eralde.github.io/mndw/ui/tooltip) | Describes its first slotted element on hover and focus. |
| [`<mndw-scroll-area>`](https://eralde.github.io/mndw/ui/scroll-area) | Native viewport with a visible scrollbar when content overflows. |
| [`<mndw-table>`](https://eralde.github.io/mndw/ui/table) | Framework-neutral table with properties for rows and columns; includes `<mndw-column-menu>`. |
| [`<mndw-line-chart>`](https://eralde.github.io/mndw/ui/line-chart) | Timestamped multi-series line and area chart. |
| [`<mndw-bar-chart>`](https://eralde.github.io/mndw/ui/bar-chart) | Timestamped positional bar chart. |
| [`<mndw-sparkline>`](https://eralde.github.io/mndw/ui/sparkline) | Compact percentage bar chart. |
| [`<mndw-heat-strip>`](https://eralde.github.io/mndw/ui/heat-strip) | Compact utilization heat strip. |
| [CSS classes](https://eralde.github.io/mndw/ui/css-classes) | Global layout, status, form, and table styles. |

## Read on

See the [UI components overview](https://eralde.github.io/mndw/ui/), [Styling and UI](https://eralde.github.io/mndw/guides/styling-and-ui), and [Shared UI components](https://eralde.github.io/mndw/guides/ui-components).
