<script lang="ts">
import type {GridStack as GridStackType} from 'gridstack';
import {onDestroy} from 'svelte';
import {pluginRegistry} from '../runtime/plugin-registry.js';
import DashboardGrid from './DashboardGrid.svelte';
import FloatingAddPanel from './FloatingAddPanel.svelte';
import {
  addWidgetTile,
  destroyAllTiles,
  removeWidgetTile,
  resizeWidgetTile,
} from './grid-dashboard-setup.js';
import {
  type PersistedGridTile,
  loadGridLayout,
  parseWidgetTileId,
  saveGridLayout,
} from './grid-layout-persistence.js';
import type {WidgetSize} from './widget-size.js';
import {raiseInstanceCounter} from './widget-counter.js';

const PERSIST_DEBOUNCE_MS = 500;

let grid: GridStackType | null = $state(null);
let addPanelOpen = $state(false);
let loading = $state(true);
let restoring = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function resolveWidgetSize(pluginName: string): WidgetSize | undefined {
  const plugin = pluginRegistry.get(pluginName);

  return plugin?.entry.type === 'widget' ? plugin.entry.size : undefined;
}

function handleGridReady(readyGrid: GridStackType): void {
  grid = readyGrid;
  restoring = true;

  try {
    const layout = loadGridLayout(resolveWidgetSize);

    if (layout !== null) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, non-reactive tally
      const maxCounter = new Map<string, number>();

      for (const tile of layout) {
        const parsed = parseWidgetTileId(tile.id);

        if (parsed === null) {
          continue;
        }

        addWidgetTile(readyGrid, parsed.pluginName, {
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h,
          instanceId: `${parsed.pluginName}:${parsed.counter}`,
        });
        maxCounter.set(
          parsed.pluginName,
          Math.max(maxCounter.get(parsed.pluginName) ?? 0, parsed.counter),
        );
      }

      for (const [name, counter] of maxCounter) {
        raiseInstanceCounter(name, counter);
      }
    }
  } finally {
    restoring = false;
    loading = false;
  }
}

function handleWidgetRemoved(id: string): void {
  removeWidgetTile(id);
}

function handleWidgetResized(id: string, size: {w: number; h: number}): void {
  resizeWidgetTile(id, size);
}

function handleLayoutChanged(layout: PersistedGridTile[]): void {
  // Restored tiles are added programmatically; their change events must not persist.
  if (restoring) {
    return;
  }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => saveGridLayout(layout), PERSIST_DEBOUNCE_MS);
}

function handleAddWidget(pluginName: string): void {
  if (grid !== null) {
    addWidgetTile(grid, pluginName);
  }

  addPanelOpen = false;
}

onDestroy(() => {
  clearTimeout(debounceTimer);

  if (grid !== null) {
    // Leaving the dashboard view is a host navigation, not instance disposal, so
    // instance storage is preserved for when the persisted layout is restored.
    destroyAllTiles('host-navigation');
    grid.destroy(false);
  }
});
</script>

<div class="mndw-dashboard-page">
  <div class="mndw-dashboard__grid-wrapper">
    <DashboardGrid
      onGridReady={handleGridReady}
      onWidgetRemoved={handleWidgetRemoved}
      onLayoutChanged={handleLayoutChanged}
      onWidgetResized={handleWidgetResized}
    />
  </div>

  {#if loading}
    <div class="mndw-dashboard__loading">Loading dashboard...</div>
  {/if}

  <div class="mndw-dashboard__toolbar">
    {#if pluginRegistry.getWidgets().length > 0}
      <button onclick={() => (addPanelOpen = true)}>+ Add Widget</button>
    {:else}
      <span class="mndw-dashboard__toolbar--empty">No widgets available</span>
    {/if}
  </div>
</div>

<FloatingAddPanel
  open={addPanelOpen}
  onAddWidget={handleAddWidget}
  onClose={() => (addPanelOpen = false)}
/>
