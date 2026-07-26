<script lang="ts">
import type {HostClient} from '../types.js';

interface Props {
  hosts: HostClient[];
  selectedMac: string;
  onSelect: (mac: string) => void;
  onClose: () => void;
}

let {hosts, selectedMac, onSelect, onClose}: Props = $props();
// Intentional: seed local edit state from the initial prop value.
// svelte-ignore state_referenced_locally
let chosen = $state(selectedMac);
</script>

<div class="settings-form">
  <mndw-select
    class="device-select"
    value={chosen}
    label="Device"
    placeholder="-- Choose --"
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
      role="button"
      tabindex="-1"
      onkeydown={() => undefined}
      variant="secondary"
      onclick={onClose}
    >Cancel</mndw-button>
    <mndw-button
      role="button"
      tabindex="-1"
      onkeydown={() => undefined}
      variant="primary"
      onclick={() => onSelect(chosen)}
      disabled={!chosen}
    >
      Apply
    </mndw-button>
  </div>
</div>

<style>
/* Rendered inside the host overlay shell body; the shell owns surface, border,
   padding, title, and close button, so this only styles the form controls. */
.settings-form { font-family: var(--mndw-font-sans); }
.device-select { display: block; margin-bottom: 12px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
