# `<mndw-slider>`

The host has `role="slider"` and handles numeric range input by keyboard and pointer.

## Examples

### Default range

```html demo
<mndw-field label="Volume"><mndw-slider value="40"></mndw-slider></mndw-field>
```

### Custom range

```html demo
<mndw-field label="Transmit power">
  <mndw-slider name="power" min="0" max="20" step="5" value="10" value-text="10 dBm"></mndw-slider>
</mndw-field>
```

### Disabled

```html demo
<mndw-field label="Managed power"><mndw-slider min="0" max="100" value="65" disabled></mndw-slider></mndw-field>
```

## Reference

Properties are numeric `value`, `min`, `max`, and `step` (defaults `0`, `100`, and `1`, with `value` defaulting to
`min`), `valueText` (`value-text` attribute), and shared `name`, `disabled`, `required`, and `invalid`. Parts are
`track`, `fill`, `thumb`, and `output`. `min`, `max`, and `step` reflect; `value` does not and its attribute remains
the form-reset default.

`value` is numeric end to end. Writes clamp into range and snap to the step grid measured from `min`. Both events
carry `detail: {value: number}`. `mndwinput` fires on each pointer move or keystroke that changes the value.
`mndwchange` commits once on pointer up/cancel when the value changed since pointer down; keyboard changes commit on
the same keystroke. Programmatic writes emit neither event. `FormData` always includes the slider's `name`, because
the slider always has a value.

Arrow keys step, PageUp and PageDown jump a tenth of the range (at least one step), and Home and End go to `min` and
`max`. `required` is accepted but inert because the slider always holds a value. Range and step validity flags are
normally clear because writes are normalized; they can expose contradictory configuration such as `min` above
`max`. A non-empty `valueText` is announced as `aria-valuetext` and shown in the output part; an empty value leaves it
unset. The accessible name comes from an external `<label for>` or `<mndw-field>`.
