<script lang="ts">
import ActionControl from './ActionControl.svelte';
import GaugeOrBars from './GaugeOrBars.svelte';
import ResultsRow from './ResultsRow.svelte';
import type {LayoutLabels, RunView} from '../model/run-view.js';

interface Props {
  run: Readonly<RunView>;
  labels: Readonly<LayoutLabels>;
  locale: string;
  pingPhaseLabel: string;
  formatPing: (value: number) => string;
  onStart: () => void;
  onStop: () => void;
}

let {run, labels, locale, pingPhaseLabel, formatPing, onStart, onStop}: Props =
  $props();
</script>

<div
  class="medium-row"
  data-testid="medium-row"
>
  <GaugeOrBars
    {run}
    {locale}
    pingLabel={labels.ping}
    {pingPhaseLabel}
    {formatPing}
    medium={true}
  />
  <ActionControl
    {run}
    {labels}
    compact={true}
    {onStart}
    {onStop}
  />
</div>
<ResultsRow
  {run}
  {labels}
/>

<style>
.medium-row {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 0.5rem;
  min-inline-size: 0;
  min-block-size: 0;
}
</style>
