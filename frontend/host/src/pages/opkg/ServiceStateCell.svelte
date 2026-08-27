<script lang="ts">
import type {ServiceState} from '../../services/service-client.js';
import {hostT} from '../../services/host-i18n.svelte.js';
import type {ServiceRow} from './service-row.js';

type Props = {row: ServiceRow};

let {row}: Props = $props();

const TONE: Record<ServiceState, string> = {
  running: 'badge-running',
  stopped: 'badge-stopped',
  unknown: 'badge-unknown',
};

const toneClass = $derived.by(() => TONE[row.service.state] ?? 'badge-unknown');
const label = $derived.by(() =>
  row.rowError ? hostT('services.probe-failed') : row.service.state
);
</script>

<span class="badge {toneClass}">{label}</span>
{#if row.service.pid !== undefined}
  <small class="pid">{hostT('services.pid', {pid: row.service.pid})}</small>
{/if}

<style>
.badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 0.625rem; text-transform: capitalize; font-size: .75rem; }
.badge-running { color: var(--mndw-success); }
.badge-stopped { color: var(--mndw-warning); }
.badge-unknown { color: var(--mndw-text-subtle); }
.pid { display: block; color: var(--mndw-text-subtle); }
</style>
