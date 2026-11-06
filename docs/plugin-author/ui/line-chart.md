# `<mndw-line-chart>`

The line chart plots receive and transmit throughput on the same ten-minute time axis. Its arrays and domain are assigned as DOM properties.

## Examples

<script setup lang="ts">
import {mount} from '../.vitepress/theme/ui-demos/line-chart.js';
</script>

<UiScriptDemo :mount="mount" />

<<< ../.vitepress/theme/ui-demos/line-chart.ts

## Reference

`series` is a property containing `MndwChartSeries[]`. Each series has an `id`, optional `label`, a color (`accent`,
`success`, `warning`, or `muted`), and timestamped `{time, value}` points. `time` is epoch milliseconds;
`MndwChartPoint` requires it. Set `domain` to `{start, end}` to control the displayed time range. `series`, `domain`,
and formatter callbacks are property-only; replace arrays with new references when data changes. `*Props` interfaces
are optional assignment bags, while initialized elements have concrete defaults.

Line values default to network-speed formatting; `valueFormatter(value)` and `timeFormatter(epochMs)` customize
tooltip and axis text. Use `value-label` and `empty-label` for chart text. The chart has `role="img"`; an authored
`aria-label` wins, otherwise its accessible name uses each series' `label` or `id`. The `container`, `plot`, `grid`,
`axis`, `tooltip`, and `empty` parts are available for styling. Tooltips stay local to the plot; redrawing data clears
stale tooltip state without replaying it until the pointer moves again. `formatSpeed` is exported for matching text
outside the chart.
