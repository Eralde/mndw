<script lang="ts">
import type {LayoutLabels, RunView} from '../model/run-view.js';

interface Props {
  run: Readonly<RunView>;
  labels: Readonly<LayoutLabels>;
  resultsInline: boolean;
  onStart: () => void;
  onStop: () => void;
}

let {run, labels, resultsInline, onStart, onStop}: Props = $props();
</script>

<div
  class="line-layout"
  class:line-short={resultsInline}
>
  <div class="line-main">
    <span
      class="line-phase"
      style="min-inline-size: 5rem"
    >{run.phaseLabel}</span>
    <span
      class="line-value"
      style="font-variant-numeric: tabular-nums; min-inline-size: 12ch"
    >{run.currentValue}</span>
    {#if resultsInline}
      <div
        class="line-results"
        data-testid="results"
        role="group"
        aria-label={run.results.summary}
      >
        <span class="line-result"><span aria-hidden="true">↓</span> <span
            class="download-value"
          >{run.results.download}</span></span>
        <span class="line-result"><span aria-hidden="true">↑</span> <span
            class="upload-value"
          >{run.results.upload}</span></span>
        <span class="line-result">{labels.ping} {run.results.ping}</span>
      </div>
    {/if}
    {#if run.running}
      <mndw-button
        class="line-action"
        type="button"
        size="sm"
        data-testid="stop"
        onclick={onStop}
        style="min-inline-size: 6.5rem; margin-inline-start: auto"
      >{labels.stop}</mndw-button>
    {:else}
      <mndw-button
        class="line-action"
        type="button"
        size="sm"
        variant="primary"
        data-testid="start"
        onclick={onStart}
        style="min-inline-size: 6.5rem; margin-inline-start: auto"
      >{labels.start}</mndw-button>
    {/if}
  </div>
  {#if !resultsInline}
    <div
      class="line-results"
      data-testid="results"
      role="group"
      aria-label={run.results.summary}
    >
      <span class="line-result"><span aria-hidden="true">↓</span> <span
          class="download-value"
        >{run.results.download}</span></span>
      <span class="line-result"><span aria-hidden="true">↑</span> <span
          class="upload-value"
        >{run.results.upload}</span></span>
      <span class="line-result">{labels.ping} {run.results.ping}</span>
    </div>
  {/if}
</div>

<style>
.line-layout {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 0.75rem;
  min-inline-size: 0;
}

.line-main {
  display: flex;
  min-inline-size: 0;
  min-block-size: 2rem;
  align-items: center;
  gap: 0.75rem;
}

.line-phase,
.line-value {
  flex: 0 0 auto;
  white-space: nowrap;
}

.line-phase {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
}

.line-value {
  overflow: hidden;
  font-size: var(--mndw-text-sm);
  text-overflow: ellipsis;
}

.line-action {
  flex: 0 0 auto;
}

.line-results {
  display: flex;
  flex: 0 0 auto;
  gap: 0.5rem;
  min-inline-size: 0;
  overflow: hidden;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.line-main > .line-results {
  flex: 1 1 0;
}

.line-result {
  flex: 0 1 auto;
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.line-short .line-results {
  margin-inline-start: 0;
  font-size: 0.625rem;
}

.download-value {
  color: var(--mndw-accent);
}

.upload-value {
  color: var(--mndw-success);
}
</style>
