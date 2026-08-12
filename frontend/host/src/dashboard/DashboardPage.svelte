<script lang="ts">
import type {GridStack as GridStackType} from 'gridstack';
import {onDestroy, onMount} from 'svelte';
import {SvelteMap} from 'svelte/reactivity';
import {mobileMediaQuery} from '../layout/breakpoint.js';
import {pluginRegistry} from '../runtime/plugin-registry.js';
import {depsStatusMap} from '../state/deps-status.svelte.js';
import DashboardGrid from './DashboardGrid.svelte';
import FloatingAddPanel from './FloatingAddPanel.svelte';
import MobileDashboard from './MobileDashboard.svelte';
import MobileOrderOverlay from './MobileOrderOverlay.svelte';
import {addWidgetTile, resizeWidgetTile} from './grid-dashboard-setup.js';
import {
  type PersistedGridTile,
  loadDashboardLayout,
  parseWidgetTileId,
  placeTileBelowLayout,
  saveDashboardLayout,
} from './grid-layout-persistence.js';
import {
  destroyAllTiles,
  ensureTileController,
  hydratePendingTiles,
  removeTileController,
} from './tile-controller.js';
import {getNextInstanceId, raiseInstanceCounter} from './widget-counter.js';
import type {WidgetSize} from './widget-size.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {appState} from '../state/app.svelte.js';

const PERSIST_DEBOUNCE_MS = 500;

function resolveWidgetSize(pluginName: string): WidgetSize | undefined {
  const plugin = pluginRegistry.get(pluginName);

  return plugin?.entry.type === 'widget' ? plugin.entry.size : undefined;
}

const mobileQuery = mobileMediaQuery();

let grid: GridStackType | null = $state(null);
let addPanelOpen = $state(false);
let orderOverlayOpen = $state(false);
let isMobile = $state(mobileQuery.matches);
let tiles: PersistedGridTile[] = $state([]);
let mobileOrder: string[] = $state([]);
let restoring = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

// Load once, synchronously, before either renderer mounts (children mount before
// the parent's onMount, so handleGridReady needs `tiles` populated already).
{
  const layout = loadDashboardLayout(resolveWidgetSize);

  if (layout !== null) {
    tiles = layout.tiles;
    mobileOrder = layout.mobileOrder;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, non-reactive tally
    const maxCounter = new Map<string, number>();

    for (const tile of layout.tiles) {
      const parsed = parseWidgetTileId(tile.id);

      if (parsed !== null) {
        maxCounter.set(
          parsed.pluginName,
          Math.max(maxCounter.get(parsed.pluginName) ?? 0, parsed.counter),
        );
      }
    }

    for (const [name, counter] of maxCounter) {
      raiseInstanceCounter(name, counter);
    }
  }
}

function persistNow(): void {
  clearTimeout(debounceTimer);
  saveDashboardLayout({
    tiles: $state.snapshot(tiles),
    mobileOrder: $state.snapshot(mobileOrder),
  });
}

function scheduleSave(): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

function handleWidgetRemoved(tileId: string): void {
  removeTileController(tileId);
  tiles = tiles.filter((tile) => tile.id !== tileId);
  mobileOrder = mobileOrder.filter((id) => id !== tileId);
  persistNow();
}

function requestRemoveTile(tileId: string): void {
  const activeGrid = grid;

  if (!isMobile && activeGrid !== null) {
    const gridItem = activeGrid
      .getGridItems()
      .find((item) => item.gridstackNode?.id === tileId);

    if (gridItem !== undefined) {
      // The grid's `removed` event owns teardown via handleWidgetRemoved.
      activeGrid.removeWidget(gridItem, true);

      return;
    }
  }

  handleWidgetRemoved(tileId);
}

function handleGridReady(readyGrid: GridStackType): void {
  grid = readyGrid;
  restoring = true;

  try {
    for (const tile of tiles) {
      const parsed = parseWidgetTileId(tile.id);

      if (parsed === null) {
        continue;
      }

      addWidgetTile(readyGrid, parsed.pluginName, requestRemoveTile, {
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h,
        instanceId: `${parsed.pluginName}:${parsed.counter}`,
      });
    }
  } finally {
    restoring = false;
  }
}

function handleGridDestroyed(): void {
  grid = null;
}

function handleLayoutChanged(layout: PersistedGridTile[]): void {
  // Restored tiles are added programmatically; their change events must not persist.
  if (restoring) {
    return;
  }

  tiles = layout;
  scheduleSave();
}

function handleWidgetResized(id: string, size: {w: number; h: number}): void {
  // Desktop-only by construction: the mobile renderer never emits resize events, so
  // plugins never receive onResize while mobile (spec: onResize is desktop contract).
  resizeWidgetTile(id, size);
}

function addMobileWidget(pluginName: string): void {
  const size = resolveWidgetSize(pluginName);

  if (size === undefined) {
    return;
  }

  const instanceId = getNextInstanceId(pluginName);
  const controller = ensureTileController(
    pluginName,
    instanceId,
    requestRemoveTile,
  );

  if (controller === null) {
    return;
  }

  // No GridStack on mobile to auto-place: compute desktop geometry below the
  // current layout so the tile appears at the end on the next desktop visit.
  tiles = [...tiles, {id: controller.id, ...placeTileBelowLayout(tiles, size)}];
  mobileOrder = [...mobileOrder, controller.id];
  persistNow();
}

function handleAddWidget(pluginName: string): void {
  addPanelOpen = false;

  if (isMobile) {
    addMobileWidget(pluginName);

    return;
  }

  const activeGrid = grid;

  if (activeGrid === null) {
    return;
  }

  const id = addWidgetTile(activeGrid, pluginName, requestRemoveTile);

  if (id !== null) {
    // tiles updates arrive via the grid's added/change events; the order entry is
    // ours to append (spec: adds update both collections regardless of breakpoint).
    mobileOrder = [...mobileOrder, id];
    scheduleSave();
  }
}

const handleBreakpointChange = (event: MediaQueryListEvent): void => {
  isMobile = event.matches;

  if (!event.matches) {
    orderOverlayOpen = false;
  }
};

const overlayCards = $derived.by(() => {
  const counts = new SvelteMap<string, number>();

  for (const id of mobileOrder) {
    const parsed = parseWidgetTileId(id);

    if (parsed !== null) {
      counts.set(parsed.pluginName, (counts.get(parsed.pluginName) ?? 0) + 1);
    }
  }

  return mobileOrder.flatMap((id) => {
    const parsed = parseWidgetTileId(id);

    if (parsed === null) {
      return [];
    }

    const label = pluginRegistry.get(parsed.pluginName)?.entry.label
      ?? parsed.pluginName;

    return [{
      id,
      label: (counts.get(parsed.pluginName) ?? 0) > 1
        ? `${label} ${parsed.counter}`
        : label,
    }];
  });
});

function handleOrderCommit(order: string[]): void {
  mobileOrder = order;
  orderOverlayOpen = false;
  persistNow();
}

$effect(() => {
  // Read the reactive map so status transitions re-run this effect even when no tile
  // is pending yet; hydration itself is idempotent and cheap.
  void [...depsStatusMap.entries()];
  hydratePendingTiles();
});

onMount(() => {
  mobileQuery.addEventListener('change', handleBreakpointChange);

  return () =>
    mobileQuery.removeEventListener('change', handleBreakpointChange);
});

onDestroy(() => {
  clearTimeout(debounceTimer);
  // Leaving the dashboard view is a host navigation, not instance disposal, so
  // instance storage is preserved for when the persisted layout is restored.
  destroyAllTiles('host-navigation');
});
</script>

<div
  class="mndw-dashboard-page"
  data-locale={appState.locale}
>
  {#if isMobile}
    <MobileDashboard
      order={mobileOrder}
      onRemoveRequest={requestRemoveTile}
    />
  {:else}
    <div class="mndw-dashboard__grid-wrapper">
      <DashboardGrid
        onGridReady={handleGridReady}
        onGridDestroyed={handleGridDestroyed}
        onWidgetRemoved={handleWidgetRemoved}
        onLayoutChanged={handleLayoutChanged}
        onWidgetResized={handleWidgetResized}
      />
    </div>
  {/if}

  <div class="mndw-dashboard__toolbar">
    {#if pluginRegistry.getWidgets().length > 0}
      <mndw-button
        variant="secondary"
        onclick={() => (addPanelOpen = true)}
      >{hostT('dashboard.add-widget')}</mndw-button>
      {#if isMobile && mobileOrder.length > 1}
        <mndw-button
          variant="secondary"
          onclick={() => (orderOverlayOpen = true)}
        >
          {hostT('dashboard.arrange-widgets')}
        </mndw-button>
      {/if}
    {:else}
      <span class="mndw-dashboard__toolbar--empty">{
        hostT('dashboard.no-widgets')
      }</span>
    {/if}
  </div>
</div>

<FloatingAddPanel
  open={addPanelOpen}
  onAddWidget={handleAddWidget}
  onClose={() => (addPanelOpen = false)}
/>

<MobileOrderOverlay
  open={isMobile && orderOverlayOpen}
  cards={overlayCards}
  onCommit={handleOrderCommit}
/>
