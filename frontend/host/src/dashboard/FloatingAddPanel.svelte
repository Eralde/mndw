<script lang="ts">
import EmptyState from '../components/EmptyState.svelte';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {appState} from '../state/app.svelte.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {getHostServices} from '../host-services-context.js';
import {getPluginManifestPresentation} from '../services/plugin-catalog.service.js';

interface Props {
  onAddWidget: (pluginName: string) => void;
  close: (result: undefined) => void;
}

let {onAddWidget, close}: Props = $props();
const registry = getHostServices().registry;

// Copy before sorting so registry ordering is never mutated. Labels and descriptions
// resolve from the startup catalog before a widget has mounted.
let availableWidgets = $derived.by(() => {
  const locale = appState.locale;

  return registry.getWidgets().map((widget) => ({
    widget,
    ...getPluginManifestPresentation(widget.entry, widget.catalog, locale),
  })).sort((a, b) =>
    a.label.localeCompare(b.label)
    || a.widget.entry.name.localeCompare(b.widget.entry.name)
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
    {#each availableWidgets as item (item.widget.entry.name)}
      {@const widget = item.widget}
      {@const deps = getDepsStatus(widget.entry.name)}
      <mndw-button
        variant="secondary"
        onclick={() => addWidget(widget.entry.name)}
      >
        <span class="mndw-floating-panel__label">{item.label}</span>
        {#if item.description !== ''}
          <span class="mndw-floating-panel__description">{
            item.description
          }</span>
        {/if}
        <span class="mndw-floating-panel__size">
          {
            hostT('dashboard.widget-size', {width: widget.entry.size.w,
            height: widget.entry.size.h})
          }
        </span>
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
