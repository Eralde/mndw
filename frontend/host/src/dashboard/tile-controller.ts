import {FALLBACK_DEVICE_INFO, FALLBACK_HOST_INFO} from '../constants.js';
import {type PluginContextServices, createPluginContext} from '../runtime/plugin-context.js';
import type {OverlayTeardownReason} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, type PluginRegistry} from '../runtime/plugin-registry.js';
import {getPluginLoadState} from '../runtime/plugin-load-state.svelte.js';
import {retryPluginLoad} from '../runtime/plugin-loader.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {hostT} from '../services/locale.service.js';
import {createWidgetContext} from './widget-context.js';
import {type WidgetTileHandle, mountWidgetTile} from './widget-mount.js';

/**
 * A renderer-agnostic dashboard tile: the host-owned frame (title, close control,
 * plugin body) plus the mounted plugin handle. Desktop (GridStack) and mobile (flow
 * list) renderers reparent {@link TileController.frame} into their own shells; the
 * controller — and therefore the live plugin instance — survives breakpoint switches.
 */
export interface TileController {
  id: string;
  pluginName: string;
  instanceId: string;
  frame: HTMLElement;
  body: HTMLElement;
  handle: WidgetTileHandle;
  setTileTitle: (title: string) => void;
  getTileTitle: () => string;
  /** True while the tile shows the installing placeholder awaiting hydration. */
  pending: boolean;
  /** True while no plugin module is mounted and the host shows a load failure placeholder. */
  pluginLoadPlaceholder: boolean;
  retrying: boolean;
  onRemoveRequest: (tileId: string) => void;
}

const controllers = new Map<string, TileController>();

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
  // Live status semantics: installation progress is a polite status, a failed
  // install is assertive — screen readers announce both without moving focus.
  notice.setAttribute('role', kind === 'installing' ? 'status' : 'alert');
  notice.textContent = kind === 'installing'
    ? hostT('dashboard.preparing-dependencies')
    : hostT('dashboard.dependency-install-failed');
  body.appendChild(notice);
}

function renderPluginLoadFailure(
  controller: TileController,
  onRemoveRequest: (tileId: string) => void,
  retry: () => void,
): void {
  const state = getPluginLoadState(controller.pluginName);
  const retrying = state?.status === 'loading';
  const label = state?.label ?? controller.pluginName;

  const currentNotice = controller.body.querySelector<HTMLElement>('.mndw-grid-tile__notice--plugin-load-failed');

  if (
    currentNotice?.getAttribute('aria-busy') === String(retrying)
    && currentNotice.querySelector('h3')?.textContent === hostT('dashboard.plugin-load-failed', {label})
  ) {
    return;
  }

  const notice = document.createElement('section');

  notice.className = 'mndw-grid-tile__notice mndw-grid-tile__notice--plugin-load-failed';
  notice.setAttribute('role', 'alert');
  notice.setAttribute('aria-busy', String(retrying));

  const heading = document.createElement('h3');

  heading.textContent = hostT('dashboard.plugin-load-failed', {label});

  const retryButton = document.createElement('button');

  retryButton.type = 'button';
  retryButton.className = 'mndw-grid-tile__retry';
  retryButton.textContent = hostT('dashboard.retry-plugin-load');
  retryButton.disabled = retrying;
  retryButton.setAttribute('aria-busy', String(retrying));
  retryButton.onclick = () => {
    if (retryButton.disabled) {
      return;
    }

    retryButton.disabled = true;
    retryButton.setAttribute('aria-busy', 'true');
    notice.setAttribute('aria-busy', 'true');
    retry();
  };

  const removeButton = document.createElement('button');

  removeButton.type = 'button';
  removeButton.className = 'mndw-grid-tile__remove-failed';
  removeButton.textContent = hostT('dashboard.remove-failed-plugin');
  removeButton.onclick = () => onRemoveRequest(controller.id);

  notice.append(heading, retryButton, removeButton);
  controller.body.replaceChildren(notice);
  controller.retrying = retrying;
}

async function retryFailedPlugin(controller: TileController): Promise<void> {
  if (controller.retrying) {
    return;
  }

  controller.retrying = true;

  try {
    await retryPluginLoad(controller.pluginName);
  } finally {
    controller.retrying = false;
  }
}

/** Builds the host-owned tile frame and returns the frame root and plugin body. */
function buildTileFrame(
  label: string,
  onRemove: () => void,
): {
  frame: HTMLElement;
  body: HTMLElement;
  setTileTitle: (title: string) => void;
  getTileTitle: () => string;
} {
  const frame = document.createElement('div');

  frame.className = 'mndw-grid-tile';

  const title = document.createElement('div');

  title.className = 'mndw-grid-tile__title';
  title.textContent = label;

  title.setAttribute('data-manifest-label', label);

  let currentTitle = label;

  const removeBtn = document.createElement('button');

  removeBtn.type = 'button';
  removeBtn.className = 'mndw-grid-tile__close';

  const removeIcon = document.createElement('mndw-icon');

  removeIcon.setAttribute('name', 'x');
  removeBtn.append(removeIcon);
  removeBtn.setAttribute('aria-label', hostT('dashboard.remove-widget', {label}));
  removeBtn.onclick = (event) => {
    event.stopPropagation();
    onRemove();
  };

  const body = document.createElement('div');

  body.className = 'mndw-grid-tile__body';

  const setTileTitle = (tileTitle: string): void => {
    const fallback = title.getAttribute('data-manifest-label') ?? label;
    const effectiveTitle = tileTitle || fallback;

    currentTitle = effectiveTitle;
    title.textContent = effectiveTitle;
    removeBtn.setAttribute('aria-label', hostT('dashboard.remove-widget', {label: fallback}));
  };

  const getTileTitle = (): string => currentTitle;

  frame.append(title, removeBtn, body);

  return {frame, body, setTileTitle, getTileTitle};
}

function hydrateLoadedPlugin(
  controller: TileController,
  plugin: LoadedPlugin,
  pluginContextServices: PluginContextServices,
  registry: Pick<PluginRegistry, 'get'>,
): void {
  const status = getDepsStatus(controller.pluginName);

  controller.pluginLoadPlaceholder = false;
  controller.retrying = false;

  if (status === 'installing') {
    renderTileNotice(controller.body, 'installing');
    controller.handle = placeholderTileHandle();
    controller.pending = true;

    return;
  }

  if (status === 'failed') {
    renderTileNotice(controller.body, 'failed');
    controller.handle = placeholderTileHandle();
    controller.pending = false;

    return;
  }

  controller.body.textContent = '';
  controller.handle = mountWidgetTile(
    controller.body,
    plugin,
    createWidgetContext(
      pluginContextServices,
      registry,
      controller.pluginName,
      controller.instanceId,
      undefined,
      controller.setTileTitle,
    ),
  );
  controller.pending = false;
}

/**
 * Returns the registered controller for `widget-<instanceId>` or creates one: builds
 * the frame, mounts the plugin (or a deps notice), and registers it. Returns `null`
 * when the plugin is unavailable or not a widget. Reuse is what makes breakpoint
 * switches reparent instead of remount — the second renderer gets the same frame.
 */
export function ensureTileController(
  pluginContextServices: PluginContextServices,
  registry: Pick<PluginRegistry, 'get'>,
  pluginName: string,
  instanceId: string,
  onRemoveRequest: (tileId: string) => void,
): TileController | null {
  const id = `widget-${instanceId}`;
  const existing = controllers.get(id);

  if (existing !== undefined) {
    return existing;
  }

  const plugin = registry.get(pluginName);
  const loadedWidget = plugin?.entry.type === 'widget' ? plugin : undefined;
  const loadState = getPluginLoadState(pluginName);

  if (
    loadedWidget === undefined
    && !(loadState?.runnable === true
      && loadState.type === 'widget'
      && (loadState.status === 'failed' || loadState.status === 'loading'))
  ) {
    return null;
  }

  const label = loadedWidget?.entry.label ?? loadState?.label ?? pluginName;
  const {frame, body, setTileTitle, getTileTitle} = buildTileFrame(label, () => onRemoveRequest(id));
  const controller: TileController = {
    id,
    pluginName,
    instanceId,
    frame,
    body,
    handle: placeholderTileHandle(),
    setTileTitle,
    getTileTitle,
    pending: false,
    pluginLoadPlaceholder: loadedWidget === undefined,
    retrying: loadState?.status === 'loading',
    onRemoveRequest,
  };

  controllers.set(id, controller);

  if (controller.pluginLoadPlaceholder) {
    renderPluginLoadFailure(controller, onRemoveRequest, () => {
      void retryFailedPlugin(controller);
    });
  } else if (loadedWidget !== undefined) {
    hydrateLoadedPlugin(controller, loadedWidget, pluginContextServices, registry);
  }

  return controller;
}

function refreshPluginLoadPlaceholder(
  controller: TileController,
  onRemoveRequest: (tileId: string) => void,
  registry: Pick<PluginRegistry, 'get'>,
  pluginContextServices: PluginContextServices,
): void {
  if (controllers.get(controller.id) !== controller || !controller.pluginLoadPlaceholder) {
    return;
  }

  const state = getPluginLoadState(controller.pluginName);

  if (state?.status === 'loaded') {
    const plugin = registry.get(controller.pluginName);

    if (plugin?.entry.type === 'widget') {
      hydrateLoadedPlugin(controller, plugin, pluginContextServices, registry);
    }

    return;
  }

  if (state?.status === 'failed' || state?.status === 'loading') {
    renderPluginLoadFailure(controller, onRemoveRequest, () => {
      void retryFailedPlugin(controller);
    });
  }
}

/** Refreshes failure placeholders after a retry or a newer loader generation completes. */
export function refreshPluginLoadPlaceholders(
  pluginContextServices: PluginContextServices,
  registry: Pick<PluginRegistry, 'get'>,
): void {
  for (const controller of controllers.values()) {
    if (!controller.pluginLoadPlaceholder) {
      continue;
    }

    refreshPluginLoadPlaceholder(
      controller,
      controller.onRemoveRequest,
      registry,
      pluginContextServices,
    );
  }
}

export function getTileController(tileId: string): TileController | undefined {
  return controllers.get(tileId);
}

/** Mounts pending placeholders when dependency status transitions to ready or failed. */
export function hydratePendingTiles(
  pluginContextServices: PluginContextServices,
  registry: Pick<PluginRegistry, 'get'>,
): void {
  for (const controller of controllers.values()) {
    if (!controller.pending) {
      continue;
    }

    const plugin = registry.get(controller.pluginName);

    if (plugin?.entry.type !== 'widget') {
      controller.pending = false;

      continue;
    }

    hydrateLoadedPlugin(controller, plugin, pluginContextServices, registry);
  }
}

/**
 * Disposes a single tile: unmounts its plugin, closes its overlays, clears only that
 * instance's storage, and detaches its frame from whichever shell holds it.
 */
export function removeTileController(
  tileId: string,
  options: {clearStorage?: boolean} = {},
): void {
  const controller = controllers.get(tileId);

  if (controller === undefined) {
    return;
  }

  controllers.delete(tileId);
  controller.frame.remove();
  controller.handle.dispose({
    clearStorage: options.clearStorage ?? true,
    closeReason: 'plugin-unmount',
  });
}

/** Refreshes frame title/close label after a hot-reload swaps the plugin module. */
function refreshTileFrame(frame: HTMLElement, label: string): void {
  const title = frame.querySelector('.mndw-grid-tile__title');

  if (title !== null) {
    title.textContent = label;

    title.setAttribute('data-manifest-label', label);
  }

  frame.querySelector('.mndw-grid-tile__close')?.setAttribute(
    'aria-label',
    hostT('dashboard.remove-widget', {label}),
  );
}

/**
 * Re-mounts every live tile of `pluginName` with the hot-reloaded `next` module,
 * reusing each controller's body, instance id, and storage. If any candidate
 * `createInstance` fails, candidates are disposed and `prior` is remounted; reports
 * `false` in that case. No-op returning `true` when no tile matches.
 */
export async function remountWidgetTiles(
  pluginContextServices: PluginContextServices,
  _registry: Pick<PluginRegistry, 'get'>, // kept to keep signature aligned with `defaultRemountWidgets`
  pluginName: string,
  next: LoadedPlugin,
  prior: LoadedPlugin,
): Promise<boolean> {
  const affected = [...controllers.values()]
    .filter((controller) => controller.pluginName === pluginName && !controller.pending);

  if (affected.length === 0) {
    return true;
  }

  for (const controller of affected) {
    controller.handle.dispose({clearStorage: false, closeReason: 'host-navigation'});
  }

  const mountAll = (plugin: LoadedPlugin): WidgetTileHandle[] =>
    affected.map((controller) => {
      refreshTileFrame(controller.frame, plugin.entry.label);
      controller.setTileTitle('');

      const hostInfo = appState.hostInfo ?? FALLBACK_HOST_INFO;
      const deviceInfo = appState.deviceInfo ?? FALLBACK_DEVICE_INFO;

      controller.handle = mountWidgetTile(
        controller.body,
        plugin,
        createPluginContext({
          entry: plugin.entry,
          instanceId: controller.instanceId,
          hostInfo,
          deviceInfo,
          setTileTitle: controller.setTileTitle,
          catalogCell: plugin.catalog,
          services: pluginContextServices,
        }),
      );

      return controller.handle;
    });

  const candidateHandles = mountAll(next);
  const settled = await Promise.all(candidateHandles.map((handle) => handle.whenReady()));

  if (settled.every(Boolean)) {
    return true;
  }

  for (const handle of candidateHandles) {
    handle.dispose({clearStorage: false, closeReason: 'host-navigation'});
  }

  const priorHandles = mountAll(prior);

  await Promise.all(priorHandles.map((handle) => handle.whenReady()));

  return false;
}

/**
 * Tears down every tile. `closeReason` is `host-navigation` when the dashboard page
 * itself unmounts (leaving the view) and preserves instance storage.
 */
export function destroyAllTiles(closeReason: OverlayTeardownReason = 'plugin-unmount'): void {
  for (const [id, controller] of controllers) {
    try {
      controller.handle.dispose({clearStorage: false, closeReason});
    } catch (error) {
      console.error(`[mndw] Failed to unmount tile ${id}:`, error);
    }
  }

  controllers.clear();
}
