# `<mndw-switch>`

The host has `role="switch"`; the toggle takes effect immediately and emits `mndwchange`.

## Examples

### Off and on

```html demo
<mndw-field label="Automatic updates"><mndw-switch name="updates"></mndw-switch></mndw-field>
<mndw-field label="Dark theme"><mndw-switch name="theme" value="dark" checked></mndw-switch></mndw-field>
```

### Disabled

```html demo
<mndw-field label="Managed setting"><mndw-switch checked disabled></mndw-switch></mndw-field>
```

## Reference

`checked` and `value` reflect. `value` defaults to `on` and is the token submitted while the switch is on. The shared
form properties are `name`, `disabled`, `required`, and `invalid`. Parts are `track`, `thumb`, and `label`.

`mndwchange` carries `{checked: boolean}` and fires on user activation, not on a programmatic write. Space and Enter
toggle the host. The host carries `role="switch"`, the tab stop, and keyboard handling; the shadow track and thumb are
presentational. `FormData` includes `value` while checked and omits the switch while unchecked; form reset restores
the authored `checked` attribute.

`required` is accepted but inert because a switch always holds a value. `invalid` is reflected for styling; it sets
no validity flag or `aria-required`, and `<mndw-field>` owns the `aria-invalid` announcement. The accessible name
comes from an external label or field. Slotted content is rendered in the `label` part, but a wrapping field still
renders its own label.
