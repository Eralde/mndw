# `<mndw-slider>`

The host has `role="slider"` and handles numeric range input by keyboard and pointer.

## Examples

### Default range

```html demo
<mndw-field label="Volume"><mndw-slider value="40"></mndw-slider></mndw-field>
```

### Custom range

<script setup lang="ts">
import {mount} from '../.vitepress/theme/ui-demos/slider.js';
</script>

<UiScriptDemo :mount="mount" />

<<< ../.vitepress/theme/ui-demos/slider.ts

### Disabled

```html demo
<mndw-field label="Managed power"><mndw-slider min="0" max="100" value="65" disabled></mndw-slider></mndw-field>
```

## Reference

Properties are numeric `value`, `min`, `max`, and `step` (defaults `0`, `100`, and `1`, with `value` defaulting to
`min`), `valueFormatter(value)`, and shared `name`, `disabled`, `required`, and `invalid`. `valueFormatter` is a
property-only callback. Parts are `track`, `fill`, `thumb`, and `output`. `min`, `max`, and `step` reflect; `value` does
not and its attribute remains the form-reset default.

`value` is numeric end to end. Writes clamp into range and snap to the step grid measured from `min`. Both events
carry `detail: {value: number}`. `mndwinput` fires on each pointer move or keystroke that changes the value.
`mndwchange` commits once on pointer up/cancel when the value changed since pointer down; keyboard changes commit on
the same keystroke. Programmatic writes emit neither event. `FormData` always includes the slider's `name`, because
the slider always has a value.

Arrow keys step, PageUp and PageDown jump a tenth of the range (at least one step), and Home and End go to `min` and
`max`. `required` is accepted but inert because the slider always holds a value. Range and step validity flags are
normally clear because writes are normalized; they can expose contradictory configuration such as `min` above
`max`. The output part and `aria-valuetext` both use `valueFormatter(value)` when set, otherwise `String(value)`. If
the formatter throws or returns a non-string, the slider falls back to `String(value)`. The accessible name comes from
an external `<label for>` or `<mndw-field>`.
