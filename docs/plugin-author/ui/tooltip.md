# `<mndw-tooltip>`

Describes its first slotted trigger on hover and focus. It is not form-associated.

## Examples

### On a button

```html demo
<mndw-tooltip text="Restarts the device immediately" placement="bottom">
  <mndw-button variant="danger">Restart</mndw-button>
</mndw-tooltip>
```

### On an icon

```html demo
<mndw-tooltip text="Refresh status" placement="right">
  <mndw-button variant="ghost" aria-label="Refresh status">
    <mndw-icon name="refresh-cw"></mndw-icon>
  </mndw-button>
</mndw-tooltip>
```

## Reference

Properties are `text`, `placement` (`top`, `bottom`, `left`, or `right`; default `top`), `delay` (milliseconds
before showing; default `500`), and `hideDelay` (`hide-delay` attribute; milliseconds between the pointer leaving
the trigger-and-bubble hover region and the close; default `300`). The component exposes part `tooltip`.

The first assigned element in the default slot is the trigger; additional elements are ignored and warned about once.
It shows after the delay on hover or focus, and hides after the hide delay once the pointer leaves both the trigger
and the bubble, on blur (unless the pointer is still in the hover region), or immediately on Escape. Escape is not
consumed. Empty `text` renders no tooltip role or description.

The trigger and the bubble form one hover region: moving the pointer across the gap between them does not close the
tooltip, leaving both starts the hide-delay countdown, and re-entering either within the delay cancels the close, so
there is no flicker while crossing. The open bubble takes pointer events and its text can be selected and copied
with the mouse; starting a selection or dragging it does not close the tooltip, even if the pointer briefly leaves
the bubble.

`hide-delay` is reflected like `delay`; negative values are treated as `0`, and a removed or non-numeric attribute
falls back to the default. With `0` the tooltip closes as soon as the pointer leaves both, so the bubble stays
hoverable only if the pointer reaches it without an intermediate pause. The default `300` ms keeps the 8px gap
between the trigger and the bubble crossable at very slow pointer speeds: the gap alone needs only ~70 ms at
2px per frame, and the remaining budget absorbs angled paths across the gap, sub-frame movement, and pointer
jitter, while still closing promptly once the pointer has really left the region.

The host carries `role="tooltip"` and the id so the description can be referenced across the shadow boundary. The
component adds its id to the trigger's `aria-describedby`, preserves consumer tokens, and removes only its own token
when disconnected or when the text, trigger, or id changes. It rewires if a consumer updates `aria-describedby`,
including when a consumer rewrites that attribute while the tooltip is connected.

The closed bubble is invisible, takes no pointer events, and remains in the accessibility tree so its text can
describe the trigger; setting `display: none` or `hidden` would break that relationship. Positioning uses the same
shared coordinate logic as select: it centers on the requested side, flips when clipped, clamps into the viewport,
and reports the settled side through `data-placement`.
