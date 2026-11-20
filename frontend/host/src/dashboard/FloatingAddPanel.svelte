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

function getWidgetAccessibleName(
  label: string,
  description: string | undefined,
  deps: string,
): string {
  return [label, description, deps]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ');
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
      {@const depsLabel = deps === 'installing'
      ? hostT('dashboard.preparing')
      : deps === 'failed'
      ? hostT('dashboard.unavailable')
      : ''}
      <mndw-button
        variant="secondary"
        aria-label={getWidgetAccessibleName(item.label, item.description, depsLabel)}
        onclick={() => addWidget(widget.entry.name)}
      >
        <span class="mndw-floating-panel__label">
          {item.label}
          {#if depsLabel !== ''}
            <br />
            <span
              class="mndw-floating-panel__deps {deps === 'failed' ? 'mndw-floating-panel__deps--failed' : ''}"
            >
              {depsLabel}
            </span>
          {/if}
        </span>
        {#if item.description}
          <span class="mndw-floating-panel__description">{
            item.description
          }</span>
        {/if}
      </mndw-button>
    {/each}
  {/if}
</div>
