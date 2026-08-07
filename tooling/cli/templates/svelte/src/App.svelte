<script lang="ts">
import type {PluginContext} from '@mndw/sdk';

const {ctx}: {ctx: PluginContext} = $props();

let count = $state(0);
</script>

<div class="wrap">
  <h3 class="title">__MNDW_LABEL__</h3>
  <p class="device">Device: {ctx.hostInfo.deviceName}</p>
  <button
    class="count"
    type="button"
    onclick={() => count++}
  >
    Clicked {count}
  </button>
</div>

<style>
.wrap {
  padding: var(--mndw-space-4);
  font-family: var(--mndw-font-sans);
  color: var(--mndw-text);
  background: var(--mndw-surface);
}

.title {
  margin: 0 0 var(--mndw-space-2);
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.device {
  margin: 0 0 var(--mndw-space-3);
  color: var(--mndw-text-muted);
}

.count {
  padding: var(--mndw-space-2) var(--mndw-space-3);
  font: inherit;
  color: var(--mndw-accent-contrast);
  background: var(--mndw-accent);
  border: none;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
}

.count:hover {
  background: var(--mndw-accent-hover);
}
</style>
