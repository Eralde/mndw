# `<mndw-radio-group>`

The host has `role="radiogroup"` and manages slotted `<mndw-radio>` choices. Prefer it over `<mndw-segmented>` when
there are more options, the labels are longer, or the choice belongs to a form field.

## Examples

### Basic group

```html demo
<mndw-radio-group label="Interval" name="interval" value="5">
  <mndw-radio value="1">1 s</mndw-radio>
  <mndw-radio value="5">5 s</mndw-radio>
  <mndw-radio value="10" disabled>10 s</mndw-radio>
</mndw-radio-group>
```

### Horizontal

```html demo
<mndw-radio-group label="Protocol" name="protocol" orientation="horizontal" value="https">
  <mndw-radio value="http">HTTP</mndw-radio>
  <mndw-radio value="https">HTTPS</mndw-radio>
</mndw-radio-group>
```

### Disabled

```html demo
<mndw-radio-group label="Mode" disabled value="auto">
  <mndw-radio value="auto">Automatic</mndw-radio>
  <mndw-radio value="manual">Manual</mndw-radio>
</mndw-radio-group>
```

### Sizes

```html demo
<div class="mndw-toolbar">
  <mndw-radio-group size="sm" label="Small interval" value="5">
    <mndw-radio value="1">1 s</mndw-radio>
    <mndw-radio value="5">5 s</mndw-radio>
  </mndw-radio-group>
  <mndw-radio-group size="md" label="Medium interval" value="5">
    <mndw-radio value="1">1 s</mndw-radio>
    <mndw-radio value="5">5 s</mndw-radio>
  </mndw-radio-group>
</div>
```

## Reference

The group owns `value`, `label`, `size`, and `orientation`, plus the shared `name`, `disabled`, and `required`.
`size` accepts `sm` or `md` and defaults to `md`. `orientation` accepts `vertical` (the default) or `horizontal`.
`value` is state and does not reflect. Part `group` is the group container. `mndwchange` carries
`detail: {value: string}` and fires on user activation only.

The group writes `role="radiogroup"`; each radio receives `role="radio"`, `aria-checked`, `aria-disabled`, and a
roving `tabindex`. These attributes are removed from a radio when it leaves the group. The checked radio is the tab
stop, or the first enabled radio if none is checked; the host itself stays outside the Tab order. Arrow keys move
focus and select with wraparound, and skip disabled radios: Down or Right moves forward and Up or Left moves
backward in both orientations. Space and a click select the focused radio. A disabled group or radio never selects and
never takes focus.

`FormData` submits the selected radio's `value` under `name`, and omits the group while no radio matches. Reset
restores the authored `value` attribute or clears the selection. `required` reports a missing value only while no
radio matches. The group's `label` is its accessible name, and changes emit `mndwlabelchange` for a wrapping
`<mndw-field>`.

Each `<mndw-radio>` carries required `value` and reflected `disabled`; its slotted text is its label. Parts are
`circle`, `dot`, and `label`. A radio without a value is ignored.
