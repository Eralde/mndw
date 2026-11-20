<script lang="ts">
import ServiceAutostartCell from './ServiceAutostartCell.svelte';
import ServiceStateCell from './ServiceStateCell.svelte';
import type {ServiceRow} from './service-row.js';

type Props = {row: ServiceRow; onToggle: (enabled: boolean) => void};

let {row, onToggle}: Props = $props();
</script>

<strong>{row.service.label}</strong><small>{row.service.name}</small>
{#if row.compact}<div class="compact-details">
    <ServiceStateCell {row} />
    <ServiceAutostartCell
      {row}
      {onToggle}
    />
  </div>{/if}

<style>
small { display: block; color: var(--mndw-text-subtle); }
.compact-details { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; margin-top: 0.25rem; }
.compact-details :global(mndw-switch) { flex: 0 0 auto; }
</style>
