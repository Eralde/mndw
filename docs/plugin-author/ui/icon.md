# `<mndw-icon>`

Renders one Lucide symbol from the shared sprite; `name` and `label` configure it, and the host supplies
`iconSpriteUrl`.

## Examples

### Common names

```html demo
<mndw-icon name="settings"></mndw-icon>
<mndw-icon name="search"></mndw-icon>
<mndw-icon name="menu"></mndw-icon>
<mndw-icon name="sun"></mndw-icon>
<mndw-icon name="info"></mndw-icon>
<mndw-icon name="check"></mndw-icon>
<mndw-icon name="plus"></mndw-icon>
<mndw-icon name="minus"></mndw-icon>
<mndw-icon name="refresh-cw"></mndw-icon>
<mndw-icon name="download"></mndw-icon>
<mndw-icon name="trash"></mndw-icon>
<mndw-icon name="circle-arrow-up" label="Update available"></mndw-icon>
<mndw-icon name="activity" label="Telemetry problem"></mndw-icon>
<mndw-icon name="unlink" label="Remote control unavailable"></mndw-icon>
<mndw-icon name="x"></mndw-icon>
```

### Size with CSS

```html demo
<mndw-icon name="settings" style="font-size: 16px"></mndw-icon>
<mndw-icon name="settings" style="font-size: 24px"></mndw-icon>
<mndw-icon name="settings" style="font-size: 36px"></mndw-icon>
```

### Labeled and decorative

```html demo
<mndw-icon name="info" label="Information"></mndw-icon>
<mndw-button aria-label="Settings"><mndw-icon name="settings"></mndw-icon></mndw-button>
```

## Icons inside your own SVG

Use `mndwIconHref` for `<use>` references in a custom SVG. Set the SVG and `<use>` dimensions, and let the icon
inherit color through `currentColor`. Call the update function once, then subscribe so it refreshes when the host
changes the sprite URL.

```ts
import {mndwIconHref, subscribeMndwIconSprite} from '@mndw/ui';

const svgNamespace = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(svgNamespace, 'svg');
svg.setAttribute('width', '24');
svg.setAttribute('height', '24');
svg.style.color = 'var(--mndw-text)';
svg.style.stroke = 'currentColor';

const use = document.createElementNS(svgNamespace, 'use');
use.setAttribute('width', '24');
use.setAttribute('height', '24');
svg.append(use);

const updateHref = (): void => {
  const href = mndwIconHref('activity');
  if (href === '') {
    use.removeAttribute('href');
  } else {
    use.setAttribute('href', href);
  }
};

updateHref();
const unsubscribe = subscribeMndwIconSprite(updateHref);
```

## Reference

`name` defaults to empty. Unknown or empty names render no `<use>` and still reserve the icon box. `label` defaults to
empty: labeled icons use `role="img"` with `aria-label`, while unlabeled icons are hidden from assistive technology.
The inner SVG is never focusable and exposes `part="svg"`. For an icon-only button, put the accessible name on the
button and leave the icon unlabeled.

Size comes from CSS. The host is `1em` square, so `width`, `height`, or `font-size` controls it. Color inherits through
`currentColor`. `name` and `label` reflect to attributes.

The host configures the shared sprite URL with `iconSpriteUrl`. Without it, icons render empty SVGs and make no
requests. Standalone use must provide a URL explicitly; `defineMndwUi()` without arguments remains valid and preserves
a previously configured URL.

Names come from the generated icon catalog and depend on the host build. A plugin must not assume a newer name exists
on an older host. Plugins use raw string names in templates; the SDK does not re-export the catalog. To add an icon,
update the upstream icon list and artwork, then regenerate the committed icon output; the generator reports missing
or extra files, and the icon check verifies generated output. Icon artwork and its sprite retain their upstream
license information.
