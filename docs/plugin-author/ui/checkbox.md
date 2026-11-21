# `<mndw-checkbox>`

Emits `mndwchange` and participates in forms with `name`, `value`, `required`, and `invalid`.

## Examples

### Unchecked and checked

```html demo
<mndw-checkbox name="updates">Receive updates</mndw-checkbox>
<mndw-checkbox name="wifi" checked>Wi-Fi enabled</mndw-checkbox>
```

### Disabled

```html demo
<mndw-checkbox checked disabled>Managed by policy</mndw-checkbox>
```

### Invalid

```html demo
<mndw-checkbox required invalid>Accept the terms</mndw-checkbox>
```

### Sizes

```html demo
<div class="mndw-toolbar">
  <mndw-checkbox size="sm">Small</mndw-checkbox>
  <mndw-checkbox size="md">Medium</mndw-checkbox>
</div>
```

## Reference

`checked`, `indeterminate`, `disabled`, `required`, `invalid`, `name`, and `value` configure the control. `size`
accepts `sm` or `md` and defaults to `md`; it shrinks the box and the label gap without changing the font size. The
checkbox is form-associated through `ElementInternals`; unchecked controls are omitted from `FormData`, while checked
controls submit `value` (default `on`). Form reset restores authored defaults, and a disabled `<fieldset>` disables
the checkbox. `required` participates in native form validation.

The host carries the checkbox role and focus target, so an external `<label for>` works. Slotted content provides its
accessible name. `mndwchange` fires on user changes with `detail: {checked: boolean, indeterminate: boolean}`.
Parts are `box`, `mark`, and `label`.
