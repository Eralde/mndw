<script lang="ts">
import ActionControl from './ActionControl.svelte';
import GaugeOrBars from './GaugeOrBars.svelte';
import ResultsRow from './ResultsRow.svelte';
import SpeedChart from './SpeedChart.svelte';
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

<GaugeOrBars
  {run}
  {locale}
  pingLabel={labels.ping}
  {pingPhaseLabel}
  {formatPing}
/>
<ActionControl
  {run}
  {labels}
  {onStart}
  {onStop}
/>
<div
  class="chart-box"
  style="flex: 0 0 6.5rem; block-size: 6.5rem"
>
  <SpeedChart
    download={run.downloadSeries}
    upload={run.uploadSeries}
    downloadLabel={labels.download}
    uploadLabel={labels.upload}
    emptyLabel={labels.chartEmpty}
    secondsUnit={labels.chartSeconds}
    valueLabel={labels.chartSpeed}
    {locale}
  />
</div>
<ResultsRow
  {run}
  {labels}
  pushToBottom={true}
/>

<style>
.chart-box {
  inline-size: 100%;
  min-block-size: 0;
}
</style>
