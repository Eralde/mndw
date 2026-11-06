# `<mndw-heat-strip>`

The heat strip shows radio utilization across fixed timed samples. Color intensity follows the configured utilization maximum.

## Examples

<script setup lang="ts">
import {mount} from '../.vitepress/theme/ui-demos/heat-strip.js';
</script>

<UiScriptDemo :mount="mount" />

<<< ../.vitepress/theme/ui-demos/heat-strip.ts

## Reference

Assign property-only `MndwChartSample[]` data to `points`. Each sample has a numeric `value` and optional
epoch-millisecond `time`; replace the array with a new reference when data changes. The compact time axis appears
only when every normalized sample has a finite time, so mixed timed and untimed input has no axis. `max` sets the
utilization scale ceiling and defaults to `100`; invalid values use `100` for drawing while tooltips and
accessibility retain the normalized sample values. Heat-strip colors use the utilization scale.

Values default to rounded percentages. Use `value-label`, `empty-label`, and `aria-label` to name the chart and its
empty state. `valueFormatter(value)` and `timeFormatter(epochMs)` customize displayed values and time labels. The host
has `role="img"`; an authored `aria-label` wins, otherwise its name uses `value-label` or neutral `Values`. The
`container`, `plot`, `axis`, `tooltip`, and `empty` parts are available; `axis` exists only for fully timed data.
Tooltips stay local to the plot; redrawing data clears stale tooltip state until the pointer moves again.
