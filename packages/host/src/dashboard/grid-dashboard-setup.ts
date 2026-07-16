import type {GridStack} from 'gridstack';
import {FALLBACK_HOST_INFO} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import type {OverlayTeardownReason} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {createWidgetContext} from './widget-context.js';
import {getNextInstanceId} from './widget-counter.js';
import {getWidgetSize} from './widget-size.js';
import {type WidgetTileHandle, mountWidgetTile} from './widget-mount.js';

/** A restored tile's persisted geometry plus its parsed instance id. */
export interface RestoredTilePosition {
  x: number;
  y: number;
  w: number;
  h: number;
  instanceId: string;
}

interface TileEntry {
  el: HTMLElement;
  handle: WidgetTileHandle;
  pluginName: string;
  instanceId: string;
  /** True while tile shows installing placeholder awaiting hydration. */
  pending: boolean;
}

// Keyed by GridStack widget id (`widget-<instanceId>`).
const tileRegistry = new Map<string, TileEntry>();

/**
 * Adds a widget tile to the grid, mounts the plugin into a host-owned frame, and
 * registers the tile handle. Returns the created GridStack widget id, or `null` when
 * the plugin is unavailable, is not a widget, or GridStack produced no content element.
 *
 * New tiles omit `x`/`y` so GridStack auto-places them; restored tiles override
 * `x`/`y`/`w`/`h`/`instanceId` while the current manifest `minW`/`minH` stay authoritative.
 */
export function addWidgetTile(
  grid: GridStack,
  pluginName: string,
  position?: RestoredTilePosition,
): string | null {
  const plugin = pluginRegistry.get(pluginName);

  if (plugin?.entry.type !== 'widget') {
    return null;
  }

  const {entry} = plugin; // narrowed to WidgetListEntry by the discriminant guard above
  const instanceId = position?.instanceId ?? getNextInstanceId(pluginName);
  const size = getWidgetSize(entry.size);
  const id = `widget-${instanceId}`;

  const gridItem = grid.addWidget({
    id,
    x: position?.x,
    y: position?.y,
    w: position?.w ?? size.w,
    h: position?.h ?? size.h,
    minW: size.minW,
    minH: size.minH,
  });

  const contentEl = gridItem.querySelector<HTMLElement>('.grid-stack-item-content');

  if (contentEl === null) {
    // GridStack gave us a tile without its content surface: roll it back so no orphan
    // element or untracked instance survives.
    grid.removeWidget(gridItem, true);

    return null;
  }

  const body = buildTileFrame(contentEl, entry.label, grid, gridItem);

  // GridStack init's drag during addWidget(), before the title bar DOM exists.
  // Force re-init so the handle selector finds the now-present title bar element.
  grid.prepareDragDrop(gridItem, true);

  const status = getDepsStatus(pluginName);
  let handle: WidgetTileHandle;

  if (status === 'ready') {
    const context = createWidgetContext(pluginName, instanceId);

    // mountWidgetTile tracks async (promise-based) mounts too, so remove/teardown reliably
    // dispose the instance and its overlays even if createInstance resolves after removal.
    handle = mountWidgetTile(body, plugin, context);
  } else {
    renderTileNotice(body, status);
    handle = placeholderTileHandle();
  }

  tileRegistry.set(id, {el: contentEl, handle, pluginName, instanceId, pending: status === 'installing'});

  return id;
}

const PREPARING_TEXT = 'Preparing… installing dependencies';
const FAILED_TEXT = 'Dependency install failed';

/** A no-op handle for a placeholder tile with no mounted plugin instance. */
function placeholderTileHandle(): WidgetTileHandle {
  return {
    getMounted: (): null => {
      return null;
    },
    whenReady: (): Promise<boolean> => {
      return Promise.resolve(false);
    },
    dispose: (): void => {},
  };
}

/** Replaces tile body content with a host-owned dependency-status notice. */
function renderTileNotice(body: HTMLElement, kind: 'installing' | 'failed'): void {
  body.textContent = '';

  const notice = document.createElement('div');

  notice.className = `mndw-grid-tile__notice mndw-grid-tile__notice--${kind}`;
  notice.textContent = kind === 'installing' ? PREPARING_TEXT : FAILED_TEXT;
  body.appendChild(notice);
}

function tileBody(contentEl: HTMLElement): HTMLElement {
  return contentEl.querySelector<HTMLElement>('.mndw-grid-tile__body') ?? contentEl;
}

/** Mounts pending placeholders when dependency status transitions to ready or failed. */
export function hydratePendingTiles(): void {
  for (const [id, tile] of tileRegistry) {
    if (!tile.pending) {
      continue;
    }

    const status = getDepsStatus(tile.pluginName);

    if (status === 'installing') {
      continue;
    }

    const body = tileBody(tile.el);

    if (status === 'failed') {
      renderTileNotice(body, 'failed');
      tileRegistry.set(id, {...tile, pending: false});

      continue;
    }

    const plugin = pluginRegistry.get(tile.pluginName);

    if (plugin?.entry.type !== 'widget') {
      tileRegistry.set(id, {...tile, pending: false});

      continue;
    }

    body.textContent = '';

    const context = createWidgetContext(tile.pluginName, tile.instanceId);
    const handle = mountWidgetTile(body, plugin, context);

    tileRegistry.set(id, {...tile, handle, pending: false});
  }
}

/**
 * Builds the host-owned tile frame (title, plugin body, remove control) inside the
 * GridStack content element and returns the plugin body container. The remove button
 * only asks GridStack to remove the tile; the grid's `removed` event owns the actual
 * teardown via {@link removeWidgetTile}, avoiding a double dispose.
 */
function buildTileFrame(
  contentEl: HTMLElement,
  label: string,
  grid: GridStack,
  gridItem: HTMLElement,
): HTMLElement {
  const frame = document.createElement('div');

  frame.className = 'mndw-grid-tile';

  const title = document.createElement('div');

  title.className = 'mndw-grid-tile__title';
  title.textContent = label;

  const removeBtn = document.createElement('button');

  removeBtn.type = 'button';
  removeBtn.className = 'mndw-grid-tile__close';
  removeBtn.textContent = '×';
  removeBtn.setAttribute('aria-label', `Remove ${label}`);
  removeBtn.onclick = (event) => {
    event.stopPropagation();
    grid.removeWidget(gridItem, true);
  };

  const body = document.createElement('div');

  body.className = 'mndw-grid-tile__body';

  frame.append(title, removeBtn, body);
  contentEl.appendChild(frame);

  return body;
}

/**
 * Disposes a single tile: unmounts its plugin, closes its overlays, and clears only that
 * instance's storage. Invoked by GridStack's `removed` event.
 */
export function removeWidgetTile(id: string): void {
  const tile = tileRegistry.get(id);

  if (tile === undefined) {
    return;
  }

  tileRegistry.delete(id);
  tile.handle.dispose({clearStorage: true, closeReason: 'plugin-unmount'});
}

/**
 * Re-mounts every live tile of `pluginName` with the hot-reloaded `next` module, reusing
 * each tile's content element, instance id, and GridStack geometry and preserving instance
 * storage. Awaits all mounts (including async ones); if any candidate `createInstance` fails,
 * the candidate mounts are disposed and the `prior` module is remounted into the same tiles,
 * and the call reports `false`. A no-op returning `true` when no tile matches (e.g. the plugin
 * under development is a page, or the widget has no placed tiles).
 */
export async function remountWidgetTiles(
  pluginName: string,
  next: LoadedPlugin,
  prior: LoadedPlugin,
): Promise<boolean> {
  const affected = [...tileRegistry]
    .filter(([, tile]) => tile.pluginName === pluginName && !tile.pending)
    .map(([id, tile]) => ({id, el: tile.el, instanceId: tile.instanceId, current: tile.handle}));

  if (affected.length === 0) {
    return true;
  }

  // Tear down the current (prior-module) instances first, keeping their storage so the
  // reloaded module resumes with the same persisted state.
  for (const tile of affected) {
    tile.current.dispose({clearStorage: false, closeReason: 'host-navigation'});
  }

  const mountAll = (plugin: LoadedPlugin): WidgetTileHandle[] =>
    affected.map((tile) => {
      const handle = remountTileBody(tile.el, plugin, tile.instanceId);

      tileRegistry.set(tile.id, {el: tile.el, handle, pluginName, instanceId: tile.instanceId, pending: false});

      return handle;
    });

  const candidateHandles = mountAll(next);
  const settled = await Promise.all(candidateHandles.map((handle) => handle.whenReady()));

  if (settled.every(Boolean)) {
    return true;
  }

  // A candidate mount failed: dispose the candidate mounts and restore the prior module.
  for (const handle of candidateHandles) {
    handle.dispose({clearStorage: false, closeReason: 'host-navigation'});
  }

  const priorHandles = mountAll(prior);

  await Promise.all(priorHandles.map((handle) => handle.whenReady()));

  return false;
}

/**
 * Re-mounts one tile's plugin body in place: refreshes the frame title/label, then mounts the
 * given plugin into the existing body element (cleared by the prior dispose), reusing the
 * instance id so scoped storage and overlays stay coherent across the reload.
 */
function remountTileBody(
  contentEl: HTMLElement,
  plugin: LoadedPlugin,
  instanceId: string,
): WidgetTileHandle {
  const title = contentEl.querySelector('.mndw-grid-tile__title');

  if (title !== null) {
    title.textContent = plugin.entry.label;
  }

  const removeBtn = contentEl.querySelector('.mndw-grid-tile__close');

  removeBtn?.setAttribute('aria-label', `Remove ${plugin.entry.label}`);

  const body = contentEl.querySelector<HTMLElement>('.mndw-grid-tile__body') ?? contentEl;
  const hostInfo = appState.hostInfo ?? FALLBACK_HOST_INFO;
  const context = createPluginContext(plugin.entry, instanceId, hostInfo);

  return mountWidgetTile(body, plugin, context);
}

/** Forwards new grid-unit dimensions to a tile's optional `onResize`, isolating throws. */
export function resizeWidgetTile(id: string, size: {w: number; h: number}): void {
  const tile = tileRegistry.get(id);
  const instance = tile?.handle.getMounted()?.instance;

  if (instance?.onResize === undefined) {
    return;
  }

  try {
    instance.onResize(size);
  } catch (error) {
    console.error(`[mndw] Widget "${tile?.pluginName}" onResize failed:`, error);
  }
}

/**
 * Tears down every tile. `closeReason` is `host-navigation` when the dashboard page
 * itself unmounts (leaving the view) and preserves instance storage.
 */
export function destroyAllTiles(closeReason: OverlayTeardownReason = 'plugin-unmount'): void {
  for (const [id, tile] of tileRegistry) {
    try {
      tile.handle.dispose({clearStorage: false, closeReason});
    } catch (error) {
      console.error(`[mndw] Failed to unmount tile ${id}:`, error);
    }
  }

  tileRegistry.clear();
}
