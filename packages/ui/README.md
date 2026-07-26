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
| `<mndw-option>` | Data only; announces mutations. |
| `<mndw-checkbox>` | Emits `mndwchange`; form-associated when supported. |
| `<mndw-button>` | `variant="primary"`, `"secondary"`, or `"ghost"`. |

`<mndw-select>` uses an anchored popover above `600px`, with its maximum height derived from
available viewport space. Long desktop lists scroll inside the panel. At `<=600px`, it opens a
full-width bottom sheet sized to its content up to the viewport, with title/close chrome, backdrop,
scroll lock, and a scrolling option region when the list is long. Sheet title comes from `label`,
falling back to `Select option`.

Breakpoint is evaluated from `window.innerWidth` when opening. Resizing across `600px` does not
morph an open layer; close and reopen to use the new presentation. Host focus containment is not
implemented for sheets; pressing `Tab` dismisses the panel and restores focus to the trigger.

Events are lowercase and hyphen-free (`mndwchange`) for vanilla, Svelte, Vue, and Angular.

`<mndw-checkbox>` participates in form submission through `ElementInternals`. `<mndw-button>`
does not: its native button is inside a shadow root and has no outer form owner.

## Styling

Components consume inherited `--mndw-*` tokens. Use `::part()` for component styling. Select
panels are portaled, so `panel-class` must be global and the class must be placed on the panel:

```html
<mndw-select panel-class="tx-rx-iface-panel"></mndw-select>
```

```css
.tx-rx-iface-panel::part(option) { padding: 10px; }
.tx-rx-iface-panel::part(listbox) { border-radius: 12px; }
```

The wrapper owns width and height bounds. Style `listbox` and `option` parts, not the wrapper.
Sheet chrome belongs to the host overlay and is not exposed through `::part()`.
