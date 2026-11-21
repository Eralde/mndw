# `<mndw-progress>`

A progress bar with a known value, or an indeterminate bar without one. It is a `role="progressbar"` whose ARIA lives
in `ElementInternals`, so the bar and the announced values cannot drift.

## Examples

### Determinate

```html demo
<mndw-progress value="25" max="100" label="Backup"></mndw-progress>
<mndw-progress value="60" max="100" label="Firmware upload"></mndw-progress>
<mndw-progress value="3" max="4" label="Packages installed"></mndw-progress>
```

### Indeterminate

```html demo
<mndw-progress label="Connecting to the router"></mndw-progress>
```

### With a label

```html demo
<mndw-progress value="40" max="100" label="Uploading firmware"></mndw-progress>
```

## Reference

`value` is a number, `max` defaults to `100`, and `label` is the accessible name. A `value` that is missing or not a
finite number makes the bar indeterminate, drawn like `.mndw-progress`. `max` falls back to `100` when it is zero,
negative, or not finite. A finite `value` is clamped into `[0, max]`; the authored attribute is left as written.

The element sets `role="progressbar"` and `ariaLabel` through `ElementInternals` and puts no ARIA attributes on the
host. A determinate bar publishes `ariaValueNow` (the clamped value), `ariaValueMin` (`0`), and `ariaValueMax` (the
effective max), and clears `ariaBusy`. An indeterminate bar clears those three values and sets `ariaBusy` to `true`.
Moving between the modes updates the same internals.

The bar is sized from `value / max`, with a short width transition that is disabled under `prefers-reduced-motion`; the
indeterminate slide slows down there instead of stopping. Parts are `track` and `bar`. Styling uses the same tokens as
`.mndw-progress`: `--mndw-accent` for the bar, `--mndw-surface-raised` for the track, `--mndw-radius-sm`, and
`--mndw-space-1` for the height.
