# `<mndw-bar-chart>`

This chart shows per-minute traffic using fixed epoch-millisecond samples. Bars occupy positional slots, so the chart does not require a time-domain property.

## Examples

<script setup lang="ts">
import {mount} from '../.vitepress/theme/ui-demos/bar-chart.js';
</script>

<UiScriptDemo :mount="mount" />

<<< ../.vitepress/theme/ui-demos/bar-chart.ts

## Reference

Assign `MndwChartPoint[]` to the `points` property. Each point has an epoch-millisecond `time` and numeric `value`;
the ordered points become positional band slots, with no time-domain property. `points` and formatter callbacks are
property-only; replace the array with a new reference when data changes. `*Props` interfaces are optional assignment
bags, while initialized elements expose defaults such as `points = []` and `color = 'accent'`.

`color` accepts `accent`, `success`, `warning`, or `muted`; invalid runtime values fall back to `accent`. Values
default to network-speed formatting. `value-label` and `empty-label` customize names and the empty state;
`valueFormatter(value)` and `timeFormatter(epochMs)` customize displayed values and time labels. The host has
`role="img"`; an authored `aria-label` wins, otherwise the name uses `value-label` or neutral `Values`. The
`container`, `plot`, `grid`, `axis`, `tooltip`, and `empty` parts are available for styling. Tooltips stay local to
the plot; data redraw clears stale tooltip state until the pointer moves again. `formatSpeed` is exported for
matching text outside the chart.
