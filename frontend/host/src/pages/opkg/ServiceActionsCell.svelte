<script lang="ts">
import {hostT} from '../../services/host-i18n.svelte.js';
import type {ServiceRow} from './service-row.js';
import type {ServiceAction} from './service-actions-renderer.svelte.js';

type Props = {row: ServiceRow; onRun: (action: ServiceAction) => void};

let {row, onRun}: Props = $props();

const actions = [
  {action: 'start', label: 'services.start', guardProtected: false},
  {action: 'stop', label: 'services.stop', guardProtected: true},
  {action: 'restart', label: 'services.restart', guardProtected: true},
] as const;

const visibleActions = $derived.by(() => {
  if (row.rowError || row.service.state === 'unknown') {
    return actions;
  }

  if (row.service.state === 'running') {
    return actions.filter(({action}) => action !== 'start');
  }

  return actions.filter(({action}) => action === 'start');
});
</script>

<div class="actions">
  {#each visibleActions as {action, label, guardProtected} (action)}
    {#if !guardProtected || !row.service.protected}
      <mndw-button
        variant="secondary"
        disabled={row.busy || (guardProtected && row.service.protected)}
        onclick={() => onRun(action)}
      >{hostT(label)}</mndw-button>
    {/if}
  {/each}
  {#if row.service.protected}
    <span
      class="protected-label"
      title={hostT('services.protected')}
    ><span aria-hidden="true">{hostT('services.protected-label')}</span><span
        class="mndw-visually-hidden"
      >{hostT('services.protected')}</span></span>
  {/if}
</div>

<style>
.actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.actions mndw-button { margin: 0; }
.protected-label { align-self: center; padding: 0 0.25rem; color: var(--mndw-text-subtle); font-size: .75rem; }
</style>
