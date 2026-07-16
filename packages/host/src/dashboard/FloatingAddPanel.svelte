<script lang="ts">
import {pluginRegistry} from '../runtime/plugin-registry.js';
import {getDepsStatus} from '../state/deps-status.svelte.js';

interface Props {
  open: boolean;
  onAddWidget: (pluginName: string) => void;
  onClose: () => void;
}

let {open, onAddWidget, onClose}: Props = $props();

// Copy before sorting so the registry's own ordering is never mutated. Sort by label,
// then name, matching the sidebar/router page ordering.
let availableWidgets = $derived(
  [...pluginRegistry.getWidgets()].sort(
    (a, b) =>
      a.entry.label.localeCompare(b.entry.label)
      || a.entry.name.localeCompare(b.entry.name),
  ),
);
let buttonRefs: HTMLButtonElement[] = [];

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
    >
      <div class="mndw-floating-panel__header">
        <h3 id="add-widget-title">Add Widget</h3>
        <button
          class="mndw-floating-panel__close"
          onclick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      {#if availableWidgets.length === 0}
        <p class="mndw-floating-panel__empty">No widgets available</p>
      {:else}
        {#each availableWidgets as widget, index (widget.entry.name)}
          {@const deps = getDepsStatus(widget.entry.name)}
          <button
            bind:this={buttonRefs[index]}
            onclick={() => onAddWidget(widget.entry.name)}
          >
            {widget.entry.label}
            {#if deps === 'installing'}
              <span class="mndw-floating-panel__deps">preparing…</span>
            {:else if deps === 'failed'}
              <span
                class="mndw-floating-panel__deps mndw-floating-panel__deps--failed"
              >unavailable</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}
