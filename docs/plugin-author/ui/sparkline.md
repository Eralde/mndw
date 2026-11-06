# `<mndw-sparkline>`

The CPU sparkline summarizes recent load in a compact chart. This example uses timed samples so the chart can label its time axis.

## Examples

<script setup lang="ts">
import {mount} from '../.vitepress/theme/ui-demos/sparkline.js';
</script>

<UiScriptDemo :mount="mount" />

<<< ../.vitepress/theme/ui-demos/sparkline.ts

## Reference

Assign `MndwChartSample[]` to the property-only `points` value. A sample has a numeric `value` and optional
epoch-millisecond `time`; `MndwChartPoint` requires `time`. Replace the array with a new reference when data changes.
The compact time axis appears only when every normalized sample has a finite time; mixed timed and untimed samples
render without an axis. `timeDomain` sets the axis start and end independently of the samples. With a `timeDomain`, timed samples
whose values are non-finite reserve empty slots instead of being removed from layout.

`max` sets the scale ceiling and defaults to `100`; an invalid runtime maximum falls back to `100` for drawing while
tooltip and accessibility text keep the sample's original value. `color` accepts `accent`, `success`, `warning`, or
`muted`; invalid colors fall back to `accent`. Values default to rounded percentages. Use `value-label`,
`empty-label`, and `aria-label` to name the chart and empty state. `valueFormatter(value)` and
`timeFormatter(epochMs)` customize displayed values. The host has `role="img"`; an authored `aria-label` wins,
otherwise its name uses `value-label` or neutral `Values`. The `container`, `plot`, `axis`, `tooltip`, and `empty`
parts are available; `axis` exists only for fully timed data. Tooltips are local to the plot and are cleared on data
redraw until the pointer moves again.
