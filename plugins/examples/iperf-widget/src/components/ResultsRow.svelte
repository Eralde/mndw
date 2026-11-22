<script lang="ts">
import type {LayoutLabels, RunView} from '../model/run-view.js';

interface Props {
  run: Readonly<RunView>;
  labels: Readonly<LayoutLabels>;
  pushToBottom?: boolean;
}

let {run, labels, pushToBottom = false}: Props = $props();
</script>

<div
  class="results-row"
  class:push-to-bottom={pushToBottom}
  data-testid="results"
>
  <dl class="results">
    <div>
      <dt>{labels.download}</dt>
      <dd class="download-value">{run.results.download}</dd>
    </div>
    <div>
      <dt>{labels.upload}</dt>
      <dd class="upload-value">{run.results.upload}</dd>
    </div>
    <div>
      <dt>{labels.ping}</dt>
      <dd>{run.results.ping}</dd>
    </div>
    <div>
      <dt>{labels.jitter}</dt>
      <dd>{run.results.jitter}</dd>
    </div>
  </dl>
</div>

<style>
.results-row {
  flex: 0 0 auto;
  min-inline-size: 0;
}

.results-row.push-to-bottom {
  margin-block-start: auto;
}

.results {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.25rem;
  min-inline-size: 0;
  margin: 0;
}

.results div {
  min-inline-size: 0;
}

dt {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
}

dd {
  margin: 0;
  font-size: var(--mndw-text-sm);
  font-variant-numeric: tabular-nums;
}

.download-value {
  color: var(--mndw-accent);
}

.upload-value {
  color: var(--mndw-success);
}
</style>
