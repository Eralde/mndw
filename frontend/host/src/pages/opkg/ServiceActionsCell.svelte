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
</script>

<div class="actions">
  {#each actions as {action, label, guardProtected} (action)}
    <mndw-button
      variant="secondary"
      disabled={row.busy || (guardProtected && row.service.protected)}
      {...(guardProtected && row.service.protected
      ? {title: hostT('services.protected')}
      : {})}
      onclick={() => onRun(action)}
    >{hostT(label)}</mndw-button>
  {/each}
</div>

<style>
.actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.actions mndw-button { margin: 0; }
</style>
