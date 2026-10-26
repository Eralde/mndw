<script lang="ts">
import type {PluginListEntry} from '../../../runtime/plugin-types.js';
import {hostT} from '../../../services/host-i18n.svelte.js';
import CapabilityReview from './CapabilityReview.svelte';

interface Props {
  entry: PluginListEntry;
  close: (result: 'approve' | 'deny') => void;
}

let {entry, close}: Props = $props();
</script>

<div class="mndw-approval">
  <p class="mndw-approval__declaration">
    <strong>{entry.label}</strong>
    ({entry.name}) {hostT('settings.backend-approval-declaration')}
  </p>

  <CapabilityReview {entry} />

  <div class="mndw-approval__actions">
    <mndw-button
      class="mndw-approval__deny"
      variant="danger"
      onclick={() => close('deny')}
    >
      {hostT('settings.backend-approval-deny')}
    </mndw-button>
    <mndw-button
      class="mndw-approval__approve"
      variant="primary"
      onclick={() => close('approve')}
    >
      {hostT('settings.backend-approval-approve')}
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
