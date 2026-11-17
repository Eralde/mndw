<script lang="ts">
import EmptyState from '../components/EmptyState.svelte';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {getHostServices} from '../host-services-context.js';

interface Props {
  onAddWidget: (pluginName: string) => void;
  close: (result: undefined) => void;
}

let {onAddWidget, close}: Props = $props();
const registry = getHostServices().registry;

// Copy before sorting so the registry's own ordering is never mutated. Sort by label,
// then name, matching the sidebar/router page ordering.
let availableWidgets = $derived.by(() => {
  return [...registry.getWidgets()].sort(
    (a, b) =>
      a.entry.label.localeCompare(b.entry.label)
      || a.entry.name.localeCompare(b.entry.name),
  );
});

function addWidget(pluginName: string): void {
  onAddWidget(pluginName);
  close(undefined);
}
</script>

<div class="mndw-floating-panel">
  {#if availableWidgets.length === 0}
    <EmptyState
      mode="compact"
      title={hostT('dashboard.no-widgets')}
      text={hostT('dashboard.empty-no-plugins')}
    />
  {:else}
    {#each availableWidgets as widget (widget.entry.name)}
      {@const deps = getDepsStatus(widget.entry.name)}
      <mndw-button
        variant="secondary"
        onclick={() => addWidget(widget.entry.name)}
      >
        {widget.entry.label}
        {#if deps === 'installing'}
          <span class="mndw-floating-panel__deps">{
            hostT('dashboard.preparing')
          }</span>
        {:else if deps === 'failed'}
          <span
            class="mndw-floating-panel__deps mndw-floating-panel__deps--failed"
          >
            {hostT('dashboard.unavailable')}
          </span>
        {/if}
      </mndw-button>
    {/each}
  {/if}
</div>
