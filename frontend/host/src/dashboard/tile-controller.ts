import {FALLBACK_HOST_INFO} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import type {OverlayTeardownReason} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, type PluginRegistry} from '../runtime/plugin-registry.js';
import {appState} from '../state/app.svelte.js';
import {getDepsStatus} from '../state/deps-status.svelte.js';
import {hostT} from '../services/locale.service.js';
import {createWidgetContext} from './widget-context.js';
import {type WidgetTileHandle, mountWidgetTile} from './widget-mount.js';
import type {HostServices} from '../host-services.js';

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
  notice.textContent = kind === 'installing'
    ? hostT('dashboard.preparing-dependencies')
    : hostT('dashboard.dependency-install-failed');
  body.appendChild(notice);
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
  removeBtn.textContent = '×';
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

/**
 * Returns the registered controller for `widget-<instanceId>` or creates one: builds
 * the frame, mounts the plugin (or a deps notice), and registers it. Returns `null`
 * when the plugin is unavailable or not a widget. Reuse is what makes breakpoint
 * switches reparent instead of remount — the second renderer gets the same frame.
 */
export function ensureTileController(
  pluginContextServices: Pick<HostServices, 'locale' | 'palette'>,
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

  if (plugin?.entry.type !== 'widget') {
    return null;
  }

  const {frame, body, setTileTitle, getTileTitle} = buildTileFrame(plugin.entry.label, () => onRemoveRequest(id));
  const status = getDepsStatus(pluginName);

  let handle: WidgetTileHandle;

  if (status === 'ready') {
    handle = mountWidgetTile(
      body,
      plugin,
      createWidgetContext(pluginContextServices, registry, pluginName, instanceId, undefined, setTileTitle),
    );
  } else {
    renderTileNotice(body, status);

    handle = placeholderTileHandle();
  }

  const controller: TileController = {
    id,
    pluginName,
    instanceId,
    frame,
    body,
    handle,
    setTileTitle,
    getTileTitle,
    pending: status === 'installing',
  };

  controllers.set(id, controller);

  return controller;
}

export function getTileController(tileId: string): TileController | undefined {
  return controllers.get(tileId);
}

/** Mounts pending placeholders when dependency status transitions to ready or failed. */
export function hydratePendingTiles(
  pluginContextServices: Pick<HostServices, 'locale' | 'palette'>,
  registry: Pick<PluginRegistry, 'get'>,
): void {
  for (const controller of controllers.values()) {
    if (!controller.pending) {
      continue;
    }

    const status = getDepsStatus(controller.pluginName);

    if (status === 'installing') {
      continue;
    }

    if (status === 'failed') {
      renderTileNotice(controller.body, 'failed');
      controller.pending = false;

      continue;
    }

    const plugin = registry.get(controller.pluginName);

    if (plugin?.entry.type !== 'widget') {
      controller.pending = false;

      continue;
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
}

/**
 * Disposes a single tile: unmounts its plugin, closes its overlays, clears only that
 * instance's storage, and detaches its frame from whichever shell holds it.
 */
export function removeTileController(tileId: string): void {
  const controller = controllers.get(tileId);

  if (controller === undefined) {
    return;
  }

  controllers.delete(tileId);
  controller.frame.remove();
  controller.handle.dispose({clearStorage: true, closeReason: 'plugin-unmount'});
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
  pluginContextServices: Pick<HostServices, 'locale' | 'palette'>,
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

      controller.handle = mountWidgetTile(
        controller.body,
        plugin,
        createPluginContext({
          entry: plugin.entry,
          instanceId: controller.instanceId,
          hostInfo,
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
