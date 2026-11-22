# `<mndw-switchport>`

Decorative port art for Ethernet, SFP, DSL, and combo ports. It only draws: no events, focus, tooltip, or text lines
under the port. The host is `aria-hidden="true"`; wrap it in your own button and give that button the accessible name.

## Examples

### Ethernet

```html demo
<div class="mndw-toolbar">
  <mndw-switchport label="0" color="blue" link port-role="inet"></mndw-switchport>
  <mndw-switchport label="1" color="gray" link></mndw-switchport>
  <mndw-switchport label="2" color="orange"></mndw-switchport>
</div>
```

### SFP and DSL

```html demo
<div class="mndw-toolbar">
  <mndw-switchport type="sfp" label="SFP" link></mndw-switchport>
  <mndw-switchport type="dsl" label="5"></mndw-switchport>
</div>
```

### Combo

```html demo
<div class="mndw-toolbar">
  <mndw-switchport combo="ethernet-sfp" active="ethernet" color="blue" label="0" link></mndw-switchport>
  <mndw-switchport combo="ethernet-sfp" active="sfp" color="blue" label="0" link></mndw-switchport>
  <mndw-switchport combo="sfp-ethernet" color="gray" label="5"></mndw-switchport>
</div>
```

### Mounted upside down

```html demo
<div class="mndw-toolbar">
  <mndw-switchport reversed color="blue" label="0" link></mndw-switchport>
  <mndw-switchport reversed color="gray" label="1"></mndw-switchport>
  <mndw-switchport reversed selected color="gray" label="4" link></mndw-switchport>
</div>
```

## Reference

Properties are reflected as attributes.

| Property | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `ethernet`, `sfp`, or `dsl` | `ethernet` | The socket shape. |
| `color` | `blue`, `gray`, or `orange` | `gray` | Ethernet fill and outline. SFP and DSL stay gray. Unknown values use `gray`. |
| `label` | string | `''` | The case label, drawn inside the socket. |
| `reversed` | boolean | `false` | The socket rotates 180°; the LED and label stay upright. |
| `combo` | `none`, `ethernet-sfp`, or `sfp-ethernet` | `none` | Two sockets in one dashed frame, in this order. |
| `active` | `ethernet`, `sfp`, or empty | `''` | The combo's active medium; ignored when `combo` is `none`. |
| `link` | boolean | `false` | The LED is on. In a combo it sits over the active socket. |
| `port-role` | string | `''` | `inet` draws the globe badge. The property is `portRole`. |
| `selected` | boolean | `false` | Draws a selected outline. |
| `disabled` | boolean | `false` | Dims the art. |

A combo draws both sockets, makes the active medium solid, dims the other, and keeps one label inside the Ethernet
socket. Without a valid `active` medium both sockets are dimmed and there is no LED, even while `link` is set. An
unknown `type` falls back to `ethernet` and an unknown `combo` falls back to `none`.

The art has no ARIA role, tab stop, or events, and the host sets `aria-hidden="true"` on connect. The caller owns
selection, keyboard handling, the tooltip, the text under the port, and the accessible name. Parts are `port` (the
SVG), `socket`, `ethernet`, `sfp`, `dsl`, `frame`, `led`, `globe`, `selected`, and `label` (the case label). SFP and
DSL sockets draw only `label`, so use the case text (`SFP`) or the port number.

The SVG scales with the host's `font-size` and defaults to a `3.5em` height. Colours follow the `--mndw-*` theme
tokens; there is no custom-property override API.
