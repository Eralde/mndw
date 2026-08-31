<script lang="ts">
import {hostT} from '../../../services/host-i18n.svelte.js';
import type {SelfUpdateProgress} from './self-update.types.js';

interface Props {
  progress: SelfUpdateProgress;
  close: (result: 'close') => void;
}

let {progress, close}: Props = $props();

const message = $derived.by((): string => {
  if (progress.phase === 'preparing') {
    return hostT('settings.self-update-preparing');
  }

  if (progress.phase === 'unconfirmed') {
    return hostT('settings.self-update-unconfirmed-modal');
  }

  return progress.operation === 'revert'
    ? hostT('settings.self-update-reverting', {version: progress.targetVersion})
    : hostT('settings.self-update-updating', {version: progress.targetVersion});
});
</script>

<div class="mndw-self-update-progress-modal">
  <p role={progress.phase === 'unconfirmed' ? 'alert' : 'status'}>{message}</p>

  {#if progress.phase === 'unconfirmed'}
    <mndw-button
      variant="secondary"
      onclick={() => close('close')}
    >
      {hostT('common.close')}
    </mndw-button>
  {/if}
</div>

<style>
.mndw-self-update-progress-modal {
  display: grid;
  min-width: min(420px, calc(100vw - var(--mndw-space-6)));
  gap: var(--mndw-space-4);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
}

p {
  margin: 0;
}

mndw-button {
  justify-self: end;
}
</style>
