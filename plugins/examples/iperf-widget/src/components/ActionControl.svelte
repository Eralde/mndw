<script lang="ts">
import type {LayoutLabels, RunView} from '../model/run-view.js';

interface Props {
  run: Readonly<RunView>;
  labels: Readonly<LayoutLabels>;
  compact?: boolean;
  onStart: () => void;
  onStop: () => void;
}

let {run, labels, compact = false, onStart, onStop}: Props = $props();
</script>

<div
  class="action-zone"
  class:compact
>
  <div
    class="action-row"
    data-testid="action-row"
    style="display: flex; justify-content: center"
  >
    {#if run.running}
      <mndw-button
        class="action-button"
        type="button"
        size="sm"
        data-testid="stop"
        onclick={onStop}
      >{labels.stop}</mndw-button>
    {:else}
      <mndw-button
        class="action-button"
        type="button"
        size="sm"
        variant="primary"
        data-testid="start"
        onclick={onStart}
      >{labels.start}</mndw-button>
    {/if}
  </div>
  <span
    class="action-status"
    aria-live="off"
  >{run.running ? '' : run.statusText}</span>
</div>

<style>
.action-row {
  display: flex;
  justify-content: center;
  align-items: center;
  min-block-size: 2rem;
  min-inline-size: 0;
}

.action-zone {
  display: grid;
  flex: 0 0 3.25rem;
  grid-template-rows: 2rem 1rem;
  gap: 0.25rem;
  min-inline-size: 0;
}

.action-zone.compact {
  flex: 0 0 auto;
  inline-size: max-content;
}

.action-zone.compact .action-status {
  inline-size: 9rem;
  max-inline-size: 9rem;
}

.action-status {
  display: block;
  min-inline-size: 0;
  overflow: hidden;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
