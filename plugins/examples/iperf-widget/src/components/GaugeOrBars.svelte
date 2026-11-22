<script lang="ts">
import Gauge from './Gauge.svelte';
import type {RunView} from '../model/run-view.js';

interface Props {
  run: Readonly<RunView>;
  pingLabel: string;
  pingPhaseLabel: string;
  locale: string;
  formatPing: (value: number) => string;
  medium?: boolean;
}

let {run, pingLabel, pingPhaseLabel, locale, formatPing, medium = false}:
  Props = $props();
</script>

<div
  class="gauge-panel gauge-box"
  class:medium
  data-testid="gauge-box"
  style="display: block; position: relative; flex: 1 1 0; min-block-size: 0"
>
  {#if run.running && run.phase === 'ping'}
    <mndw-bar-chart
      class="ping-chart"
      points={run.pingPoints}
      valueDomain={run.pingDomain}
      valueLabel={pingLabel}
      valueFormatter={formatPing}
      timeFormatter={() => ''}
      aria-label={pingPhaseLabel}
      style="position: absolute; inset: 0; inline-size: 100%; block-size: 100%; min-block-size: 0"
    ></mndw-bar-chart>
  {:else}
    <Gauge
      speed={run.running ? run.speed : 0}
      phaseLabel={run.phaseLabel}
      phase={run.phase}
      {locale}
      running={run.running}
    />
  {/if}
</div>

<style>
.gauge-panel {
  inline-size: 100%;
  min-inline-size: 0;
}

.gauge-panel.medium {
  inline-size: auto;
  block-size: 100%;
}

.ping-chart {
  display: block;
}
</style>
