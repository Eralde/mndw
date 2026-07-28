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
| `<mndw-checkbox>` | Emits `mndwchange`; form-associated when supported. |
| `<mndw-button>` | `variant="primary"`, `"secondary"`, or `"ghost"`. |
| `<mndw-scroll-area>` | Native viewport with an always-visible bespoke scrollbar when content overflows. |

`<mndw-select>` uses an anchored popover above `600px`, with its maximum height derived from
available viewport space. Long desktop lists scroll inside the panel's nested native scroll area;
the panel owns border, radius, background, shadow, clipping, and a stable scrollbar gutter. At
`<=600px`, it opens a full-width bottom sheet sized to its content up to the viewport, with
title/close chrome, backdrop, scroll lock, and a scrolling option region when the list is long.
Sheet mode caps the panel through `--mndw-select-sheet-max-height`. Sheet title comes from `label`,
falling back to `Select option`.

Breakpoint is evaluated from `window.innerWidth` when opening. Resizing across `600px` does not
morph an open layer; close and reopen to use the new presentation. Host focus containment is not
implemented for sheets; pressing `Tab` dismisses the panel and restores focus to the trigger.

Events are lowercase and hyphen-free (`mndwchange`) for vanilla, Svelte, Vue, and Angular.

`<mndw-checkbox>` participates in form submission through `ElementInternals`. `<mndw-button>`
does not: its native button is inside a shadow root and has no outer form owner.

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

The overlay wrapper owns width and height bounds; the panel owns its visual chrome, and the
nested `<mndw-scroll-area>` owns option scrolling. Its `viewport`, `scrollbar`, `track`, and
`thumb` parts are forwarded by the select panel. Use `refresh()` for content changes observers
cannot see, or `viewportElement` for direct native `scrollTop`/`scrollTo` access.

Scrollbar hooks are `--mndw-scrollbar-size`, `--mndw-scrollbar-thumb`,
`--mndw-scrollbar-thumb-hover`, `--mndw-scrollbar-track`, `--mndw-scrollbar-radius`, and
`--mndw-scrollbar-thumb-min-size` (default `24px`). Defaults are usage-site fallbacks, so
ancestor overrides inherit correctly. Scrollbar chrome is `aria-hidden`; the native viewport and
listbox remain the accessible interaction surface.

When `ElementInternals.ariaControlsElements` is unavailable, the select omits `aria-controls`
because its panel is portaled into another node tree. Rich option child nodes are cloned into the
panel without HTML string interpolation.
Sheet chrome belongs to the host overlay and is not exposed through `::part()`.
