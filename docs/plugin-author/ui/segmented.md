# `<mndw-segmented>`

The host has `role="radiogroup"` and manages slotted `<mndw-segment>` choices.

## Examples

### Three choices

```html demo
<mndw-segmented label="Range" name="range" value="day">
  <mndw-segment value="day">Day</mndw-segment>
  <mndw-segment value="week">Week</mndw-segment>
  <mndw-segment value="month">Month</mndw-segment>
</mndw-segmented>
```

### Disabled choice

```html demo
<mndw-segmented label="Range" value="day">
  <mndw-segment value="day">Day</mndw-segment>
  <mndw-segment value="week">Week</mndw-segment>
  <mndw-segment value="month" disabled>Month</mndw-segment>
</mndw-segmented>
```

## Reference

The group owns `value`, `label`, and shared `name`, `disabled`, `required`, and `invalid`; `value` is state and does
not reflect. Part `group` is the segmented container. `mndwchange` carries `detail: {value: string}` and fires on
user activation only. Each `<mndw-segment>` carries required `value` and `disabled`, both reflected, and exposes part
`segment`; a segment without a value is ignored.

The group writes `role="radiogroup"`; each segment receives `role="radio"`, `aria-checked`, `aria-disabled`, and a
roving `tabindex`. These attributes are removed from a segment when it leaves the group. The checked segment is the
tab stop, or the first enabled segment if none is checked; the host stays at `tabindex="-1"`. Arrow keys move and
select with wraparound; Home and End jump to the first and last enabled choice. Space and Enter select the focused
segment, skipping disabled choices.

Nothing selected is a valid initial state. `FormData` omits the group, and `required` reports a missing value only
while no segment matches. Reset restores the authored `value` attribute or clears selection. The group's `label` is
its accessible name, and changes emit `mndwlabelchange` for a wrapping `<mndw-field>`.
