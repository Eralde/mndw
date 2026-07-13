<script lang="ts">
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import CapabilityReview from './CapabilityReview.svelte';

interface Props {
  entry: PluginListEntry;
  close: (result: 'approve' | 'deny') => void;
}

let {entry, close}: Props = $props();
</script>

<div class="mndw-approval">
  <p class="mndw-approval__declaration">
    <strong>{entry.label}</strong> ({entry.name}) declares a backend. Review its
    capabilities before approving.
  </p>

  <CapabilityReview descriptor={entry.backend} />

  <div class="mndw-approval__actions">
    <button
      class="mndw-approval__deny"
      type="button"
      onclick={() => close('deny')}
    >
      Deny
    </button>
    <button
      class="mndw-approval__approve"
      type="button"
      onclick={() => close('approve')}
    >
      Approve
    </button>
  </div>
</div>

<style>
.mndw-approval {
  display: grid;
  min-width: min(420px, calc(100vw - var(--mndw-space-6)));
  gap: var(--mndw-space-4);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

.mndw-approval__declaration {
  margin: 0;
  font-size: var(--mndw-text-sm);
  line-height: var(--mndw-leading);
}

.mndw-approval__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--mndw-space-2);
}

.mndw-approval__actions button {
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-sm);
  padding: var(--mndw-space-2) var(--mndw-space-3);
  font: inherit;
  font-weight: var(--mndw-weight-semibold);
  cursor: pointer;
}

.mndw-approval__approve {
  border-color: var(--mndw-accent) !important;
  background: var(--mndw-accent);
  color: var(--mndw-accent-contrast);
}

.mndw-approval__approve:hover {
  background: var(--mndw-accent-hover);
}

.mndw-approval__deny {
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
}
</style>
