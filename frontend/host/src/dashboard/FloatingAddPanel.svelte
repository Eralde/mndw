<script lang="ts">
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {appState} from '../state/app.svelte.js';
import {getHostServices} from '../host-services-context.js';

interface Props {
  open: boolean;
  onAddWidget: (pluginName: string) => void;
  onClose: () => void;
}

let {open, onAddWidget, onClose}: Props = $props();
const services = getHostServices();
const registry = services.registry;

// Copy before sorting so the registry's own ordering is never mutated. Sort by label,
// then name, matching the sidebar/router page ordering.
let availableWidgets = $derived.by(() => {
  return [...registry.getWidgets()].sort(
    (a, b) => {
      return a.entry.label.localeCompare(b.entry.label)
        || a.entry.name.localeCompare(b.entry.name);
    },
  );
});

let buttonRefs: HTMLElement[] = [];

$effect(() => {
  if (open) {
    const timer = setTimeout(() => buttonRefs[0]?.focus(), 0);

    return () => clearTimeout(timer);
  }
});

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    onClose();
  }
}
</script>

{#if open}
  <div
    class="mndw-floating-panel-backdrop"
    onclick={onClose}
    role="presentation"
  >
    <div
      class="mndw-floating-panel"
      onclick={(event) => event.stopPropagation()}
      onkeydown={handleKeydown}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="add-widget-title"
      data-locale={appState.locale}
    >
      <div class="mndw-floating-panel__header">
        <h3 id="add-widget-title">{hostT('dashboard.add-widget')}</h3>
        <mndw-button
          variant="ghost"
          class="mndw-floating-panel__close"
          onclick={onClose}
          aria-label={hostT('common.close')}
        >
          <mndw-icon name="x"></mndw-icon>
        </mndw-button>
      </div>
      {#if availableWidgets.length === 0}
        <p class="mndw-floating-panel__empty">
          {hostT('dashboard.no-widgets')}
        </p>
      {:else}
        {#each availableWidgets as widget, index (widget.entry.name)}
          {@const deps = getDepsStatus(widget.entry.name)}
          <mndw-button
            variant="secondary"
            bind:this={buttonRefs[index]}
            onclick={() => onAddWidget(widget.entry.name)}
          >
            {widget.entry.label}
            {#if deps === 'installing'}
              <span class="mndw-floating-panel__deps">
                {hostT('dashboard.preparing')}</span>
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
  </div>
{/if}
