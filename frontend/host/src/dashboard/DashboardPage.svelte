<script lang="ts">
import type {OverlaySession} from '@mndw/sdk';
import type {GridStack as GridStackType} from 'gridstack';
import {onDestroy, onMount, tick} from 'svelte';
import {mobileMediaQuery} from '../layout/breakpoint.js';
import {depsStatusMap} from '../state/deps-status.svelte.js';
import EmptyState from '../components/EmptyState.svelte';
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
  clearWidgetTileGridSize,
  destroyAllTiles,
  ensureTileController,
  getTileController,
  hydratePendingTiles,
  refreshPluginLoadPlaceholders,
  removeTileController,
} from './tile-controller.js';
import {getNextInstanceId, raiseInstanceCounter} from './widget-counter.js';
import type {WidgetSize} from './widget-size.js';
import {hostT} from '../services/host-i18n.svelte.js';
import {
  clearInstanceStorage,
  finalizeInstanceStorageRemoval,
  getInstanceStorageRevision,
} from '../services/storage.service.js';
import {openHostModal} from '../services/overlay/host-overlay.js';
import {toast} from '../services/toast/toast.svelte.js';
import {getPluginManifestPresentation} from '../services/plugin-catalog.service.js';
import {appState} from '../state/app.svelte.js';
import {
  createHostServicesContext,
  getHostServices,
} from '../host-services-context.js';
import {HOST_PATHS} from '../router/host-routes.js';
import {
  getPluginListRevision,
  getPluginLoadListOutcome,
  getPluginLoadState,
  getPluginLoadStates,
} from '../runtime/plugin-load-state.svelte.js';

const PERSIST_DEBOUNCE_MS = 500;
const LAYOUT_SAVE_TOAST_KEY = 'dashboard-layout-save';
const REMOVAL_TOAST_KEY = 'dashboard-widget-removal';
const REMOVAL_TOAST_DURATION_MS = 8000;
const services = getHostServices();
const hostModalContext = createHostServicesContext(services);
const registry = services.registry;
const pluginContextServices = {
  locale: services.locale,
  palette: services.palette,
  telemetry: services.telemetry,
  telemetryGathering: services.telemetryGathering,
  eventStream: services.eventStream,
  rci: services.rci,
  theme: services.theme,
  tickerPool: services.tickerPool,
  overlayRuntime: services.overlayRuntime,
  navigation: services.router.navigation,
};

function resolveWidgetSize(pluginName: string): WidgetSize | undefined {
  const plugin = registry.get(pluginName);

  return plugin?.entry.type === 'widget' ? plugin.entry.size : undefined;
}

const mobileQuery = mobileMediaQuery();

let dashboardRoot: HTMLDivElement | undefined;
let grid: GridStackType | null = $state(null);
let orderOverlayOpen = $state(false);
let addPanelSession: OverlaySession<undefined> | null = null;
let orderOverlaySession: OverlaySession<undefined> | null = null;

type AddPanelProps = {
  onAddWidget: (pluginName: string) => string | null;
  close: (result: undefined) => void;
};

type OrderOverlayProps = {
  cards: Array<{id: string; label: string}>;
  onCommit: (order: string[]) => void;
  close: (result: undefined) => void;
};
let isMobile = $state(mobileQuery.matches);
let tiles: PersistedGridTile[] = $state([]);
let mobileOrder: string[] = $state([]);
let visibleTiles = $derived.by(() =>
  tiles.filter((tile) => isTileVisible(tile.id))
);
let visibleMobileOrder = $derived.by(() => {
  const visibleIds = new Set(visibleTiles.map((tile) => tile.id));

  return mobileOrder.filter((id) => visibleIds.has(id));
});
let restoring = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let addedTileHighlightTimer: ReturnType<typeof setTimeout> | undefined;
let highlightedAddedTile: HTMLElement | undefined;
let pendingRemoval: {
  tile: PersistedGridTile;
  tileIndex: number;
  mobileIndex: number;
  pluginName: string;
  instanceId: string;
  storageRevision: symbol | undefined;
  mountSettlement: Promise<boolean> | null;
  toastId: number;
} | null = $state(null);
// @dprint-ignore
let pendingPersist: {tiles: PersistedGridTile[]; mobileOrder: string[]} | null = null;

// Load once, synchronously, before either renderer mounts (children mount before
// the parent's onMount, so handleGridReady needs `tiles` populated already).
{
  const layout = loadDashboardLayout(resolveWidgetSize, {
    listOutcome: getPluginLoadListOutcome(),
    getPlugin: getPluginLoadState,
  });

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

function isTileVisible(tileId: string): boolean {
  const parsed = parseWidgetTileId(tileId);

  if (parsed === null) {
    return false;
  }

  const status = getPluginLoadState(parsed.pluginName);

  if (status !== undefined) {
    return status.runnable && status.type === 'widget'
      && status.status !== 'not-runnable';
  }

  return registry.get(parsed.pluginName)?.entry.type === 'widget';
}

function isHiddenTile(tile: PersistedGridTile): boolean {
  const parsed = parseWidgetTileId(tile.id);

  if (parsed === null) {
    return false;
  }

  const status = getPluginLoadState(parsed.pluginName);

  return status !== undefined && status.type === 'widget' && !status.runnable;
}

function mergeHiddenTiles(
  visibleLayout: PersistedGridTile[],
): PersistedGridTile[] {
  const visibleIds = new Set(visibleLayout.map((tile) => tile.id));
  const hiddenTiles = tiles.filter((tile) =>
    isHiddenTile(tile) && !visibleIds.has(tile.id)
  );

  return [...visibleLayout, ...hiddenTiles];
}

function mergeVisibleMobileOrder(nextVisibleOrder: string[]): string[] {
  const visibleIds = new Set(visibleMobileOrder);
  let nextIndex = 0;
  const merged = mobileOrder.map((id) => {
    if (!visibleIds.has(id)) {
      return id;
    }

    const next = nextVisibleOrder[nextIndex];

    nextIndex += 1;

    return next ?? id;
  });

  for (const id of nextVisibleOrder.slice(nextIndex)) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }

  return merged;
}

function persistNow(
  layout = {
    tiles: $state.snapshot(tiles),
    mobileOrder: $state.snapshot(mobileOrder),
  },
): void {
  if (getPluginLoadListOutcome() !== 'ok') {
    clearTimeout(debounceTimer);
    pendingPersist = null;

    return;
  }

  clearTimeout(debounceTimer);

  pendingPersist = null;

  if (saveDashboardLayout(layout)) {
    toast.dismissKey(LAYOUT_SAVE_TOAST_KEY);
  } else {
    toast.show({
      key: LAYOUT_SAVE_TOAST_KEY,
      message: hostT('dashboard.layout-save-failed'),
      variant: 'warning',
    });
  }
}

function scheduleSave(): void {
  if (getPluginLoadListOutcome() !== 'ok') {
    return;
  }

  clearTimeout(debounceTimer);

  pendingPersist = {
    tiles: $state.snapshot(tiles),
    mobileOrder: $state.snapshot(mobileOrder),
  };

  debounceTimer = setTimeout(
    () => {
      if (pendingPersist !== null) {
        persistNow(pendingPersist);
      }
    },
    PERSIST_DEBOUNCE_MS,
  );
}

function finalizePendingRemoval(): void {
  const pending = pendingRemoval;

  if (pending === null) {
    return;
  }

  pendingRemoval = null;
  clearInstanceStorage(pending.pluginName, pending.instanceId);

  if (pending.mountSettlement !== null) {
    void pending.mountSettlement.then(
      () =>
        finalizeInstanceStorageRemoval(
          pending.pluginName,
          pending.instanceId,
          pending.storageRevision,
        ),
      () =>
        finalizeInstanceStorageRemoval(
          pending.pluginName,
          pending.instanceId,
          pending.storageRevision,
        ),
    );
  }
}

function undoPendingRemoval(): void {
  const pending = pendingRemoval;

  if (pending === null) {
    return;
  }

  pendingRemoval = null;
  tiles = [...tiles];
  tiles.splice(Math.min(pending.tileIndex, tiles.length), 0, pending.tile);
  mobileOrder = [...mobileOrder];
  mobileOrder.splice(
    Math.min(pending.mobileIndex, mobileOrder.length),
    0,
    pending.tile.id,
  );

  if (!isMobile && grid !== null) {
    syncDesktopGridToTiles();
  }

  persistNow();
  toast.dismiss(pending.toastId);
}

function handleWidgetRemoved(
  tileId: string,
  removedTile?: PersistedGridTile,
): void {
  if (restoring || getPluginLoadListOutcome() !== 'ok') {
    return;
  }

  const parsed = parseWidgetTileId(tileId);
  const tileIndex = tiles.findIndex((tile) => tile.id === tileId);
  const tile = removedTile
    ?? tiles[tileIndex]
    ?? {id: tileId, x: 0, y: 0, w: 1, h: 1};

  if (parsed === null || tileIndex === -1) {
    removeTileController(tileId, {clearStorage: true});

    return;
  }

  // A keyed toast is replaced in place. Dispose the previous removed instance first
  // so its storage cannot survive past the only Undo action that referred to it.
  finalizePendingRemoval();
  const controller = getTileController(tileId);
  const mountSettlement = controller?.handle?.whenReady() ?? null;
  const instanceId = `${parsed.pluginName}:${parsed.counter}`;
  const plugin = registry.get(parsed.pluginName);
  const label = controller?.getTileTitle()
    || (plugin === undefined
      ? undefined
      : getPluginManifestPresentation(
        plugin.entry,
        plugin.catalog,
        appState.locale,
      ).label)
    || parsed.pluginName;
  const mobileIndex = mobileOrder.indexOf(tileId);

  removeTileController(tileId, {clearStorage: false});

  tiles = tiles.filter((tile) => tile.id !== tileId);
  mobileOrder = mobileOrder.filter((id) => id !== tileId);

  persistNow();

  const toastId = toast.info(
    hostT('dashboard.widget-removed', {label}),
    {
      key: REMOVAL_TOAST_KEY,
      duration: REMOVAL_TOAST_DURATION_MS,
      action: {label: hostT('common.undo'), onAction: undoPendingRemoval},
    },
  );

  pendingRemoval = {
    tile,
    tileIndex,
    mobileIndex: mobileIndex === -1 ? mobileOrder.length : mobileIndex,
    pluginName: parsed.pluginName,
    instanceId,
    storageRevision: getInstanceStorageRevision(parsed.pluginName, instanceId),
    mountSettlement,
    toastId,
  };
}

function requestRemoveTile(tileId: string): void {
  if (getPluginLoadListOutcome() !== 'ok') {
    return;
  }

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
    for (const tile of visibleTiles) {
      const parsed = parseWidgetTileId(tile.id);

      if (parsed === null) {
        continue;
      }

      addWidgetTile(
        pluginContextServices,
        services.pluginStylesheets,
        registry,
        readyGrid,
        parsed.pluginName,
        requestRemoveTile,
        {
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h,
          instanceId: `${parsed.pluginName}:${parsed.counter}`,
        },
      );
    }
  } finally {
    restoring = false;
  }
}

function syncDesktopGridToTiles(): void {
  if (isMobile || grid === null) {
    return;
  }

  const desiredTiles = new Map(
    tiles.filter((tile) => isTileVisible(tile.id)).map((
      tile,
    ) => [tile.id, tile]),
  );
  const existingIds: string[] = [];

  restoring = true;

  try {
    for (const item of grid.getGridItems()) {
      const id = item.gridstackNode?.id;

      if (typeof id !== 'string') {
        grid.removeWidget(item, true, false);

        continue;
      }

      const tile = desiredTiles.get(id);

      if (tile === undefined) {
        grid.removeWidget(item, true, false);

        const parsed = parseWidgetTileId(id);
        const status = parsed === null
          ? undefined
          : getPluginLoadState(parsed.pluginName);
        const preserveStorage = status?.type === 'widget' && !status.runnable;

        removeTileController(id, {clearStorage: !preserveStorage});

        continue;
      }

      existingIds.push(id);
      grid.update(item, {x: tile.x, y: tile.y, w: tile.w, h: tile.h});
    }

    for (const tile of desiredTiles.values()) {
      if (existingIds.includes(tile.id)) {
        continue;
      }

      const parsed = parseWidgetTileId(tile.id);

      if (parsed === null) {
        continue;
      }

      addWidgetTile(
        pluginContextServices,
        services.pluginStylesheets,
        registry,
        grid,
        parsed.pluginName,
        requestRemoveTile,
        {
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h,
          instanceId: `${parsed.pluginName}:${parsed.counter}`,
        },
      );
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
  if (restoring || getPluginLoadListOutcome() !== 'ok') {
    return;
  }

  tiles = mergeHiddenTiles(layout);

  scheduleSave();
}

function handleWidgetResized(id: string, size: {w: number; h: number}): void {
  // Desktop-only by construction: the mobile renderer never emits resize events, so
  // plugins never receive onResize while mobile (spec: onResize is desktop contract).
  resizeWidgetTile(id, size);
}

function addMobileWidget(pluginName: string): string | null {
  if (getPluginLoadListOutcome() !== 'ok') {
    return null;
  }

  const size = resolveWidgetSize(pluginName);

  if (size === undefined) {
    return null;
  }

  const instanceId = getNextInstanceId(pluginName);
  const controller = ensureTileController(
    pluginContextServices,
    registry,
    pluginName,
    instanceId,
    requestRemoveTile,
    services.pluginStylesheets,
  );

  if (controller === null) {
    return null;
  }

  // No GridStack on mobile to auto-place: compute desktop geometry below the
  // current layout so the tile appears at the end on the next desktop visit.
  tiles = [...tiles, {id: controller.id, ...placeTileBelowLayout(tiles, size)}];
  mobileOrder = [...mobileOrder, controller.id];

  persistNow();

  return controller.id;
}

function handleAddWidget(pluginName: string): string | null {
  if (getPluginLoadListOutcome() !== 'ok') {
    return null;
  }

  if (isMobile) {
    return addMobileWidget(pluginName);
  }

  const activeGrid = grid;

  if (activeGrid === null) {
    return null;
  }

  const id = addWidgetTile(
    pluginContextServices,
    services.pluginStylesheets,
    registry,
    activeGrid,
    pluginName,
    requestRemoveTile,
  );

  if (id !== null) {
    // GridStack emits added during addWidget(), so `tiles` already contains complete
    // geometry here. Persist both collections immediately; a queued save can be lost
    // when navigation destroys this page before its debounce expires.
    mobileOrder = [...mobileOrder, id];

    persistNow();

    return id;
  }

  return null;
}

async function revealAddedTile(tileId: string): Promise<void> {
  await tick();

  const tile = [
    ...(dashboardRoot?.querySelectorAll<HTMLElement>('.mndw-grid-tile') ?? []),
  ]
    .find((candidate) => candidate.dataset.widgetId === tileId);

  if (tile === undefined) {
    return;
  }

  const reducedMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (typeof tile.scrollIntoView === 'function') {
    tile.scrollIntoView({behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center'});
  }
  highlightedAddedTile?.classList.remove('mndw-grid-tile--newly-added');

  if (addedTileHighlightTimer !== undefined) {
    clearTimeout(addedTileHighlightTimer);
  }

  highlightedAddedTile = tile;
  tile.classList.add('mndw-grid-tile--newly-added');
  addedTileHighlightTimer = setTimeout(() => {
    tile.classList.remove('mndw-grid-tile--newly-added');

    if (highlightedAddedTile === tile) {
      highlightedAddedTile = undefined;
    }

    addedTileHighlightTimer = undefined;
  }, 1600);
}

function openAddWidgetModal(): void {
  if (addPanelSession !== null) {
    return;
  }

  const opener = document.activeElement;
  let addedWidgetId: string | null = null;
  const session = openHostModal<undefined, AddPanelProps>(
    services.hostOverlay,
    FloatingAddPanel,
    {
      title: hostT('dashboard.add-widget'),
      props: {
        onAddWidget: (pluginName) => {
          addedWidgetId = handleAddWidget(pluginName);

          return addedWidgetId;
        },
      },
      closeOnOutsideClick: true,
      context: hostModalContext,
    },
  );

  addPanelSession = session;
  void session.closed.then(async () => {
    if (addPanelSession === session) {
      addPanelSession = null;
    }

    if (addedWidgetId !== null) {
      if (opener instanceof HTMLElement && !opener.isConnected) {
        const returnTarget = dashboardRoot?.querySelector<HTMLElement>(
          '.mndw-dashboard__toolbar mndw-button',
        )
          ?? dashboardRoot?.querySelector<HTMLElement>(
            '.mndw-grid-tile__close',
          );

        returnTarget?.focus({preventScroll: true});
      }

      await revealAddedTile(addedWidgetId);
    }
  });
}

function openOrderModal(): void {
  if (orderOverlaySession !== null) {
    return;
  }

  orderOverlayOpen = true;
  const session = openHostModal<undefined, OrderOverlayProps>(
    services.hostOverlay,
    MobileOrderOverlay,
    {
      title: hostT('dashboard.arrange-widgets'),
      props: {cards: overlayCards, onCommit: handleOrderCommit},
      closeOnOutsideClick: true,
    },
  );

  orderOverlaySession = session;
  void session.closed.then(() => {
    if (orderOverlaySession === session) {
      orderOverlaySession = null;
      orderOverlayOpen = false;
    }
  });
}

const handleBreakpointChange = (event: MediaQueryListEvent): void => {
  isMobile = event.matches;

  if (event.matches) {
    for (const tile of tiles) {
      clearWidgetTileGridSize(tile.id);
    }
  }

  if (!event.matches) {
    orderOverlaySession?.close();
    orderOverlaySession = null;
    orderOverlayOpen = false;
  }
};

const overlayCards = $derived.by(() => {
  // Snapshot current titles when overlay opens. Avoid changing card labels while
  // user is arranging widgets if a plugin updates its title concurrently.
  if (!orderOverlayOpen) {
    return [];
  }

  return visibleMobileOrder.flatMap((id) => {
    const parsed = parseWidgetTileId(id);

    if (parsed === null) {
      return [];
    }

    const plugin = registry.get(parsed.pluginName);
    const fallback = plugin === undefined
      ? parsed.pluginName
      : getPluginManifestPresentation(
        plugin.entry,
        plugin.catalog,
        appState.locale,
      ).label;

    const currentTitle = getTileController(id)?.getTileTitle() ?? '';

    return [{
      id,
      label: currentTitle || fallback,
    }];
  });
});

function handleOrderCommit(order: string[]): void {
  if (getPluginLoadListOutcome() !== 'ok') {
    return;
  }

  mobileOrder = mergeVisibleMobileOrder(order);

  persistNow();
}

let previousPluginListOutcome = getPluginLoadListOutcome();
let previousPluginListRevision = getPluginListRevision();
let hasReconciledSuccessfulPluginList = false;

function reconcileTilesWithPluginList(): boolean {
  const pending = pendingRemoval;

  if (
    pending !== null
    && getPluginLoadState(pending.pluginName)?.type !== 'widget'
  ) {
    finalizePendingRemoval();
    toast.dismiss(pending.toastId);
  }

  const nextTiles = tiles.filter((tile) => {
    const parsed = parseWidgetTileId(tile.id);

    return parsed !== null
      && getPluginLoadState(parsed.pluginName)?.type === 'widget';
  });
  const tileIds = new Set(nextTiles.map((tile) => tile.id));
  const nextMobileOrder = mobileOrder.filter((id) => tileIds.has(id));
  const tilesChanged = nextTiles.length !== tiles.length;
  const orderChanged = nextMobileOrder.length !== mobileOrder.length;

  for (const tile of tiles) {
    const parsed = parseWidgetTileId(tile.id);

    if (parsed === null || !tileIds.has(tile.id)) {
      removeTileController(tile.id, {clearStorage: true});

      if (parsed !== null) {
        clearInstanceStorage(
          parsed.pluginName,
          `${parsed.pluginName}:${parsed.counter}`,
        );
      }

      continue;
    }

    const status = getPluginLoadState(parsed.pluginName);

    if (status?.type === 'widget' && !status.runnable) {
      removeTileController(tile.id, {clearStorage: false});
    }
  }

  if (!tilesChanged && !orderChanged) {
    return false;
  }

  tiles = nextTiles;
  mobileOrder = nextMobileOrder;

  return true;
}

$effect(() => {
  // Read the reactive map so status transitions re-run this effect even when no tile
  // is pending yet; hydration itself is idempotent and cheap.
  void [...depsStatusMap.entries()];
  void Object.values(getPluginLoadStates()).map((state) =>
    `${state.status}:${state.runnable}`
  );

  const listOutcome = getPluginLoadListOutcome();
  const pluginListRevision = getPluginListRevision();

  hydratePendingTiles(pluginContextServices, registry);
  refreshPluginLoadPlaceholders(pluginContextServices, registry);

  if (listOutcome === 'ok') {
    if (
      !hasReconciledSuccessfulPluginList
      || previousPluginListOutcome !== 'ok'
      || previousPluginListRevision !== pluginListRevision
    ) {
      const recoveredList = previousPluginListOutcome !== 'ok';
      const layoutChanged = reconcileTilesWithPluginList();
      hasReconciledSuccessfulPluginList = true;
      syncDesktopGridToTiles();

      if (recoveredList || layoutChanged) {
        persistNow();
      }
    }
  } else {
    hasReconciledSuccessfulPluginList = false;
  }

  previousPluginListOutcome = listOutcome;
  previousPluginListRevision = pluginListRevision;
});

$effect(() => {
  const pending = pendingRemoval;

  if (
    pending !== null
    && !toast.toasts.some((item) => item.id === pending.toastId)
  ) {
    finalizePendingRemoval();
  }
});

onMount(() => {
  mobileQuery.addEventListener('change', handleBreakpointChange);
  window.addEventListener('pagehide', handlePageHide);

  return () => {
    mobileQuery.removeEventListener('change', handleBreakpointChange);
    window.removeEventListener('pagehide', handlePageHide);
  };
});

function handlePageHide(): void {
  finalizePendingRemoval();
  toast.dismissKey(REMOVAL_TOAST_KEY);
}

onDestroy(() => {
  if (addedTileHighlightTimer !== undefined) {
    clearTimeout(addedTileHighlightTimer);
  }

  highlightedAddedTile?.classList.remove('mndw-grid-tile--newly-added');
  highlightedAddedTile = undefined;

  // Flush any pending layout change before host navigation tears down this page.
  if (pendingPersist !== null && getPluginLoadListOutcome() === 'ok') {
    persistNow(pendingPersist);
  }
  finalizePendingRemoval();
  toast.dismissKey(REMOVAL_TOAST_KEY);
  addPanelSession?.close();
  orderOverlaySession?.close();
  // Leaving the dashboard view is a host navigation, not instance disposal, so
  // instance storage is preserved for when the persisted layout is restored.
  destroyAllTiles('host-navigation');
});
</script>

<div
  bind:this={dashboardRoot}
  class="mndw-dashboard-page"
  data-locale={appState.locale}
>
  <div class="mndw-dashboard__toolbar">
    {#if registry.getWidgets().length > 0 && visibleTiles.length > 0}
      <mndw-button
        variant="secondary"
        onclick={openAddWidgetModal}
      >
        <mndw-icon
          name="plus"
          aria-hidden="true"
        ></mndw-icon>
        {hostT('dashboard.add-widget')}
      </mndw-button>

      {#if isMobile && visibleMobileOrder.length > 1}
        <mndw-button
          variant="secondary"
          onclick={openOrderModal}
        >
          {hostT('dashboard.arrange-widgets')}
        </mndw-button>
      {/if}
    {/if}
  </div>

  {#if appState.pluginLoadError !== null}
    <!-- Regular region, not an alert: the AppShell banner (role="alert") above is the
         assertive announcement; this block only explains what the banner means. -->
    <EmptyState
      title={hostT('dashboard.empty-error-title')}
      text={hostT('dashboard.empty-error-text')}
    />
  {:else if registry.getWidgets().length === 0 && visibleTiles.length === 0}
    <EmptyState
      title={hostT('dashboard.no-widgets')}
      text={hostT('dashboard.empty-no-plugins')}
      action={{label: hostT('dashboard.empty-install-plugins'),
      href: HOST_PATHS.settingsTab.plugins}}
    />
  {:else if visibleTiles.length === 0}
    <EmptyState
      title={hostT('dashboard.empty-title')}
      text={hostT('dashboard.empty-add-widget')}
      action={{label: hostT('dashboard.add-widget'), onActivate: openAddWidgetModal}}
    />
  {/if}

  {#if isMobile}
    <MobileDashboard
      order={visibleMobileOrder}
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
</div>
