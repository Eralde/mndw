# `<mndw-textarea>`

Wraps a native inner `<textarea>` with row sizing and opt-in `autosize`; it emits the same text-control events as
`<mndw-input>`.

## Examples

### Rows

```html demo
<mndw-field label="Release notes" hint="Markdown is supported.">
  <mndw-textarea name="notes" rows="5" placeholder="Write an update"></mndw-textarea>
</mndw-field>
```

### Autosize

```html demo
<mndw-field label="Message">
  <mndw-textarea autosize value="The height follows this content."></mndw-textarea>
</mndw-field>
```

### Disabled

```html demo
<mndw-field label="Archived notes"><mndw-textarea rows="3" disabled value="Read only"></mndw-textarea></mndw-field>
```

## Reference

The control shares `<mndw-input>`'s forwarding rules, form participation, and commit condition while wrapping a native
`<textarea>` in its shadow root. The shadow root delegates focus. Properties are `value`, `rows` (default `3`),
`autosize` (default `false`), `readonly`, `maxlength`, and shared `name`, `disabled`, `required`, and `invalid`.
Parts are `field` and `textarea`. `value` is state and does not reflect; the authored attribute remains the form-reset
default.

`mndwinput` fires on each edit and `mndwchange` carries `{value: string}` on blur only, when the value differs from
its value at focus. A programmatic write emits no event and resets the commit baseline. Enter inserts a newline; it
does not commit. The host forwards the resolved accessible name, description, and invalid state into the native
textarea; `<mndw-field>` keeps these relationships synchronized. Native constraint validation is mirrored through
`ElementInternals`.

`autosize` is opt-in because it uses a `ResizeObserver` to recompute height when width changes and text reflows. While
enabled, it drives height from content and drops `rows`; turning it off restores row sizing and clears inline height.
