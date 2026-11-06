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

Properties are `text`, `placement` (`top`, `bottom`, `left`, or `right`; default `top`), and `delay` (milliseconds
before showing; default `500`). Hiding is immediate. The component exposes part `tooltip`.

The first assigned element in the default slot is the trigger; additional elements are ignored and warned about once.
It shows after the delay on hover or focus, and hides on pointer leave, blur, or Escape. Escape is not
consumed. Empty `text` renders no tooltip role or description.

The host carries `role="tooltip"` and the id so the description can be referenced across the shadow boundary. The
component adds its id to the trigger's `aria-describedby`, preserves consumer tokens, and removes only its own token
when disconnected or when the text, trigger, or id changes. It rewires if a consumer updates `aria-describedby`,
including when a consumer rewrites that attribute while the tooltip is connected.

The closed bubble is invisible but remains in the accessibility tree so its text can describe the trigger; setting
`display: none` or `hidden` would break that relationship. Positioning uses the same shared coordinate logic as select: it
centers on the requested side, flips when clipped, clamps into the viewport, and reports the settled side through
`data-placement`.
