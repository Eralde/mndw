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
  <select
    class="device-select"
    bind:value={chosen}
  >
    <option value="">-- Choose --</option>
    {#each hosts as host (host.mac)}
      <option value={host.mac}>
        {host.name} {#if !host.active}(offline){/if}
      </option>
    {/each}
  </select>
  <div class="actions">
    <button
      class="btn-cancel"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      class="btn-apply"
      onclick={() => onSelect(chosen)}
      disabled={!chosen}
    >
      Apply
    </button>
  </div>
</div>

<style>
/* Rendered inside the host overlay shell body; the shell owns surface, border,
   padding, title, and close button, so this only styles the form controls. */
.settings-form { font-family: var(--mndw-font-sans); }
.device-select {
  width: 100%; padding: 8px; border: 1px solid var(--mndw-border); border-radius: 4px;
  background: var(--mndw-surface-raised); color: var(--mndw-text);
  font-size: 13px; box-sizing: border-box; margin-bottom: 12px;
}
.actions { display: flex; gap: 8px; justify-content: flex-end; }
button {
  padding: 6px 14px; border-radius: 4px; font-size: 13px; cursor: pointer; border: 1px solid var(--mndw-border);
}
.btn-cancel { background: var(--mndw-surface-raised); color: var(--mndw-text); }
.btn-apply { background: var(--mndw-accent); color: var(--mndw-accent-contrast); border-color: var(--mndw-accent); }
.btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
