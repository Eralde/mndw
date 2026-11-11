<script lang="ts">
import {hostT} from '../../../services/host-i18n.svelte.js';

interface Props {
  busy: boolean;
  disabled: boolean;
  error: string;
  onReset: () => void;
}

let {busy, disabled, error, onReset}: Props = $props();
let confirming = $state(false);

function start(): void {
  if (busy || disabled) {
    return;
  }

  confirming = true;
}

function confirm(): void {
  confirming = false;
  onReset();
}
</script>

<div class="mndw-palette-reset">
  {#if confirming}
    <p>{hostT('settings.palette.reset-confirmation')}</p>
    <mndw-button
      variant="danger"
      disabled={busy || disabled}
      onclick={confirm}
    >
      {hostT('settings.palette.reset-confirm')}
    </mndw-button>
    <mndw-button
      variant="secondary"
      disabled={busy || disabled}
      onclick={() => (confirming = false)}
    >
      {hostT('common.cancel')}
    </mndw-button>
  {:else}
    <mndw-button
      variant="danger"
      disabled={busy || disabled}
      onclick={start}
    >
      {hostT('settings.palette.reset')}{busy ? '…' : ''}
    </mndw-button>
  {/if}

  {#if error}
    <div
      class="mndw-alert mndw-alert--danger"
      role="alert"
    >
      {error}
    </div>
  {/if}
</div>

<style>
.mndw-palette-reset {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mndw-space-2);
  align-items: center;
}
</style>
