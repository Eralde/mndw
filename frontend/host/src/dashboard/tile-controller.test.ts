/* eslint id-blacklist: 0 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mountWidgetTile = vi.hoisted(() => vi.fn());

vi.mock('../runtime/plugin-registry.js', () => ({
  pluginRegistry: {get: vi.fn()},
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn((options: {instanceId: string}) => ({
    context: {instanceId: options.instanceId},
    dispose: vi.fn(),
  })),
}));

vi.mock('./widget-context.js', () => ({
  createWidgetContext: vi.fn((
    _services: unknown,
    _registry: unknown,
    _name: string,
    instanceId: string,
    _hostInfo?: unknown,
    setTileTitle?: unknown,
  ) => ({
    context: {instanceId, setTileTitle},
    dispose: vi.fn(),
  })),
}));

vi.mock('./widget-mount.js', () => ({mountWidgetTile}));

import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import {localeService} from '../services/locale.service.js';
import {paletteService} from '../services/palette.service.js';
import type {PageListEntry, WidgetListEntry} from '../runtime/plugin-types.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {
  destroyAllTiles,
  ensureTileController,
  getTileController,
  hydratePendingTiles,
  remountWidgetTiles,
  removeTileController,
} from './tile-controller.js';

const pluginContextServices = {locale: localeService, palette: paletteService};

const emptyBackend = {routes: {}};

function widgetPlugin(
  name: string,
  createInstance: (container: HTMLElement) => PluginInstance | Promise<PluginInstance>,
): LoadedPlugin {
  const entry: WidgetListEntry = {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'widget',
    size: {w: 4, h: 3},
  };

  return {entry, module: {createInstance: (container) => createInstance(container)}};
}

function pagePlugin(name: string): LoadedPlugin {
  const entry: PageListEntry = {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    depsStatus: 'ready',
    backend: emptyBackend,
    type: 'page',
    route: `/${name}`,
  };

  return {entry, module: {createInstance: () => ({unmount: vi.fn()})}};
}

function noop(): PluginInstance {
  return {unmount: vi.fn()};
}

function labelledWidget(name: string, text: string): LoadedPlugin {
  return widgetPlugin(name, (container) => {
    container.textContent = text;

    return noop();
  });
}

describe('tile controller', () => {
  beforeEach(() => {
    vi.mocked(pluginRegistry).get.mockReset();
    mountWidgetTile.mockReset();
    mountWidgetTile.mockImplementation((body: HTMLElement, plugin: LoadedPlugin) => {
      body.textContent = '';

      try {
        const instance = plugin.module.createInstance(body, {} as never);
        const mounted = instance instanceof Promise ? null : instance;

        return {
          getMounted: vi.fn(() => mounted === null ? null : {instance: mounted}),
          whenReady: vi.fn(() => Promise.resolve(mounted !== null)),
          dispose: vi.fn(),
        };
      } catch {
        return {
          getMounted: vi.fn(() => null),
          whenReady: vi.fn(() => Promise.resolve(false)),
          dispose: vi.fn(),
        };
      }
    });
  });

  afterEach(() => {
    destroyAllTiles();
    replaceDepsStatuses([]);
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('builds a frame with title, close control, and body, and mounts a ready plugin', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', vi.fn());

    expect(controller?.id).toBe('widget-clock:1');
    expect(controller?.frame.querySelector('.mndw-grid-tile__title')?.textContent).toBe('clock');
    expect(controller?.frame.querySelector('.mndw-grid-tile__close')).not.toBeNull();
    expect(mountWidgetTile).toHaveBeenCalledWith(controller?.body, expect.anything(), expect.anything());
  });

  it('updates the tile title and close aria-label via setTileTitle', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', vi.fn());

    controller?.setTileTitle('eth0');

    expect(controller?.frame.querySelector('.mndw-grid-tile__title')?.textContent).toBe('eth0');
    expect(controller?.frame.querySelector('.mndw-grid-tile__close')?.getAttribute('aria-label')).toBe('Remove clock');

    controller?.setTileTitle('');

    expect(controller?.frame.querySelector('.mndw-grid-tile__title')?.textContent).toBe('clock');
  });

  it('returns the current effective title', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', vi.fn());

    expect(controller?.getTileTitle()).toBe('clock');

    controller?.setTileTitle('eth0');

    expect(controller?.getTileTitle()).toBe('eth0');

    controller?.setTileTitle('');

    expect(controller?.getTileTitle()).toBe('clock');
  });

  it('keeps the manifest label on placeholder tiles', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'installing'}]);

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());

    expect(controller?.frame.querySelector('.mndw-grid-tile__title')?.textContent).toBe('traffic');
    expect(controller?.body.textContent).toBe('Preparing… installing dependencies');
  });

  it('returns the existing controller (same frame element) for a repeated ensure', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const onRemove = vi.fn();
    const first = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', onRemove);
    const second = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', vi.fn());

    expect(second).toBe(first);
    expect(mountWidgetTile).toHaveBeenCalledTimes(1);
  });

  it('returns null for unknown plugins and non-widget entries', () => {
    vi.mocked(pluginRegistry).get.mockReturnValueOnce(undefined);
    expect(ensureTileController(pluginContextServices, pluginRegistry, 'missing', 'missing:1', vi.fn())).toBeNull();

    vi.mocked(pluginRegistry).get.mockReturnValueOnce(pagePlugin('settings'));
    expect(ensureTileController(pluginContextServices, pluginRegistry, 'settings', 'settings:1', vi.fn())).toBeNull();
  });

  it('renders the installing notice and hydrates once deps become ready', () => {
    const createInstance = vi.fn(noop);
    let capturedContext: unknown = null;

    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', createInstance));
    vi.mocked(mountWidgetTile).mockImplementation((body: HTMLElement, plugin: unknown, ctx: unknown) => {
      const loadedPlugin = plugin as LoadedPlugin;

      body.textContent = '';
      capturedContext = ctx;

      try {
        const handle = ctx as {context: PluginContext};
        const instance = loadedPlugin.module.createInstance(body, handle.context);
        const mounted = instance instanceof Promise ? null : instance;

        return {
          getMounted: vi.fn(() => mounted === null ? null : {instance: mounted}),
          whenReady: vi.fn(() => Promise.resolve(mounted !== null)),
          dispose: vi.fn(),
        };
      } catch {
        return {
          getMounted: vi.fn(() => null),
          whenReady: vi.fn(() => Promise.resolve(false)),
          dispose: vi.fn(),
        };
      }
    });
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'installing'}]);

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());

    expect(controller?.body.textContent).toBe('Preparing… installing dependencies');
    expect(createInstance).not.toHaveBeenCalled();

    replaceDepsStatuses([{name: 'traffic', depsStatus: 'ready'}]);
    hydratePendingTiles(pluginContextServices, pluginRegistry);

    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(controller?.pending).toBe(false);
    expect(capturedContext).toEqual(
      expect.objectContaining({context: expect.objectContaining({setTileTitle: controller?.setTileTitle})}),
    );

    const setTileTitle = (capturedContext as {context: {setTileTitle: (title: string) => void}}).context.setTileTitle;

    setTileTitle('eth0');
    expect(controller?.frame.querySelector('.mndw-grid-tile__title')?.textContent).toBe('eth0');
  });

  it('renders the failed notice when hydration finds failed deps', () => {
    const createInstance = vi.fn(noop);

    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', createInstance));
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'installing'}]);

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());

    replaceDepsStatuses([{name: 'traffic', depsStatus: 'failed'}]);
    hydratePendingTiles(pluginContextServices, pluginRegistry);

    expect(controller?.body.textContent).toBe('Dependency install failed');
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('close control routes to onRemoveRequest with the tile id', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const onRemove = vi.fn();
    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', onRemove);

    controller?.frame.querySelector<HTMLButtonElement>('.mndw-grid-tile__close')?.click();

    expect(onRemove).toHaveBeenCalledWith('widget-clock:1');
  });

  it('removeTileController disposes with storage clearing and detaches the frame', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());

    document.body.appendChild(controller?.frame ?? document.createElement('div'));
    removeTileController('widget-traffic:1');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(controller?.handle.dispose).toHaveBeenCalledWith({
      clearStorage: true,
      closeReason: 'plugin-unmount',
    });
    expect(controller?.frame.isConnected).toBe(false);
    expect(getTileController('widget-traffic:1')).toBeUndefined();
  });

  it('destroyAllTiles disposes every controller with host-navigation options', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));

    const first = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());
    const second = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:2', vi.fn());

    destroyAllTiles('host-navigation');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(first?.handle.dispose).toHaveBeenCalledWith({
      clearStorage: false,
      closeReason: 'host-navigation',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(second?.handle.dispose).toHaveBeenCalledWith({
      clearStorage: false,
      closeReason: 'host-navigation',
    });
  });

  it('remountWidgetTiles preserves controllers on success and rolls back on failure', async () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(labelledWidget('traffic', 'before'));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());

    const ok = await remountWidgetTiles(
      pluginContextServices,
      pluginRegistry,
      'traffic',
      labelledWidget('traffic', 'after'),
      labelledWidget('traffic', 'before'),
    );

    expect(ok).toBe(true);
    expect(controller?.body.textContent).toBe('after');
    expect(getTileController('widget-traffic:1')).toBe(controller);

    const failing = widgetPlugin('traffic', () => {
      throw new Error('boom');
    });
    const rollback = await remountWidgetTiles(
      pluginContextServices,
      pluginRegistry,
      'traffic',
      failing,
      labelledWidget('traffic', 'restored'),
    );

    expect(rollback).toBe(false);
    expect(controller?.body.textContent).toBe('restored');
  });
});
