# `<mndw-input>`

Wraps a native inner `<input>` with delegated focus and emits `mndwinput` and `mndwchange`.

## Examples

### Empty with a placeholder

```html demo
<mndw-field label="Network name"><mndw-input placeholder="Enter a name"></mndw-input></mndw-field>
```

### Filled

```html demo
<mndw-field label="Address"><mndw-input value="192.168.1.1"></mndw-input></mndw-field>
```

### Disabled

```html demo
<mndw-field label="Device ID"><mndw-input value="router-01" disabled></mndw-input></mndw-field>
```

### Invalid

```html demo
<mndw-field label="Port" error="Enter a port from 1 to 65535.">
  <mndw-input type="number" min="1" max="65535" value="0" invalid></mndw-input>
</mndw-field>
```

## Reference

The host owns form participation. A real native `<input>` in the shadow root owns editing, caret, selection, IME, and
masking; the shadow root delegates focus, so a `<label for>` click or `.focus()` reaches it.

Properties are `value`, `type` (`text`, `password`, `search`, `number`, or `url`; default `text`, with other values
falling back to `text`), `placeholder`,
`readonly`, `min`, `max`, `step`, `maxlength`, `autocomplete`, and shared `name`, `disabled`, `required`, and
`invalid`. `value` is state and does not reflect; its authored attribute remains the form-reset default. Parts are
`field`, `input`, `prefix`, and `suffix`; the last two are adornment slots.

`mndwinput` fires on every keystroke. `mndwchange` fires on blur or Enter only when the value differs from the value
at focus; Enter resets that baseline so blur does not send a duplicate event. A programmatic write emits nothing and
replaces the baseline. Both events carry `detail: {value: string}`.

Validation delegates to the platform: `type`, `required`, `min`, `max`, `step`, and `maxlength` configure the native
input, and the host mirrors its validity and validation message through `ElementInternals`.

The host keeps its attributes while forwarding the resolved accessible name, description, and invalid state into the
shadow input. Name resolution uses `aria-labelledby`, then `aria-label`, then associated label text; descriptions map
to `aria-description`. Text under `aria-hidden` is excluded. Referenced text edits and host ARIA changes trigger
resolution again. If a `<label for>` is inserted, removed, or re-pointed after mount, call
`refreshAccessibleName()`; `<mndw-field>` handles that update for its control.
