<script lang="ts">
import type {Readable} from 'svelte/store';
import type {Translator} from '@mndw/sdk';
import type {HostClient} from '../types.js';

interface Props {
  hosts: HostClient[];
  selectedMac: string;
  translator: Readable<Translator>;
  onSelect: (mac: string) => void;
  onClose: () => void;
}

let {hosts, selectedMac, translator, onSelect, onClose}: Props = $props();
// Intentional: seed local edit state from the initial prop value.
// svelte-ignore state_referenced_locally
let chosen = $state(selectedMac);
</script>

<div class="settings-form">
  <mndw-select
    value={chosen}
    label={$translator.t('field.device')}
    placeholder={$translator.t('field.select-device')}
    onmndwchange={(e: CustomEvent<{value: string}>) => chosen = e.detail.value}
  >
    {#each hosts as host (host.mac)}
      <mndw-option value={host.mac}>
        {host.name}{#if !host.active} (offline){/if}
      </mndw-option>
    {/each}
  </mndw-select>
  <div class="actions">
    <mndw-button
      variant="secondary"
      onclick={onClose}
    >{$translator.t('action.cancel')}</mndw-button>
    <mndw-button
      variant="primary"
      onclick={() => onSelect(chosen)}
      disabled={!chosen}
    >
      {$translator.t('action.apply')}
    </mndw-button>
  </div>
</div>

<style>
/* Rendered inside the host overlay shell body; the shell owns surface, border,
   padding, title, and close button, so this only styles the form controls. */
.settings-form {
  font-family: var(--mndw-font-sans);
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
