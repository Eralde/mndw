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
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      class="mndw-approval__deny"
      variant="danger"
      onclick={() => close('deny')}
    >
      Deny
    </mndw-button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <mndw-button
      class="mndw-approval__approve"
      variant="primary"
      onclick={() => close('approve')}
    >
      Approve
    </mndw-button>
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
</style>
