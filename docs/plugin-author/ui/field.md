# `<mndw-field>`

Provides a light-DOM label, hint, and error wrapper for a single control.

## Examples

### Label and hint

```html demo
<mndw-field label="Host name" hint="Shown in the device list.">
  <mndw-input name="hostname" placeholder="gateway"></mndw-input>
</mndw-field>
```

### Label and error

```html demo
<mndw-field label="Port" error="Enter a port from 1 to 65535." required>
  <mndw-input type="number" min="1" max="65535" value="0" invalid></mndw-input>
</mndw-field>
```

## Reference

Field takes a control as a light-DOM child and wires its labeling. Properties are `label`, `hint`, `error`, and
`required`; empty strings hide their nodes. Field creates `.mndw-field__label`, `.mndw-field__hint`, and
`.mndw-field__error` once and places them around the control in label, control, hint, error order. The error has
`role="alert"` and uses plain danger-colored text. Field renders into light DOM and exposes classes rather than
`::part()` hooks.

The first child that is an `Element` becomes the control; comments, whitespace, and placeholder nodes are skipped.
Replacing it rewires the field. Field generates an `id` if needed, points its label at it, adds hint and error ids to
`aria-describedby`, sets `aria-invalid` while `error` is non-empty, and mirrors `required`. Consumer-supplied ids,
description tokens, and prior attribute values are preserved and restored. If a control is not labelable, its
`aria-labelledby` points to the field label.

The control's own accessible name always wins: this includes non-empty `aria-label`, an external
`aria-labelledby`, a consumer `<label for>` in the same tree, or a control's declared label source. Checkbox slotted
content and select's `label` property are declared sources. Controls with a changing label source dispatch
`mndwlabelchange` (`bubbles` and `composed`) so field can rewire.
