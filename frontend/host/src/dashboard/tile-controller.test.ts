// @vitest-environment happy-dom
/* eslint id-blacklist: 0 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mountWidgetTile = vi.hoisted(() => vi.fn());
const retryPluginLoad = vi.hoisted(() => vi.fn());
const retrySandboxPlugin = vi.hoisted(() => vi.fn());

vi.mock('../runtime/plugin-registry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/plugin-registry.js')>(),
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
vi.mock('../runtime/plugin-loader.js', () => ({retryPluginLoad}));
vi.mock('../runtime/sandbox-loader.js', () => ({retrySandboxPlugin}));

import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import {createHostServices} from '../host-services.js';
import type {PageListEntry, WidgetListEntry} from '../runtime/plugin-types.js';
import {
  replacePluginLoadStates,
  setPluginLoadListOutcome,
  setPluginLoadState,
} from '../runtime/plugin-load-state.svelte.js';
import {replaceDepsStatuses} from '../state/deps-status.svelte.js';
import {getTheme, setTheme} from '../services/theme.service.js';
import {
  destroyAllTiles,
  ensureTileController,
  getTileController,
  hydratePendingTiles,
  refreshPluginLoadPlaceholders,
  remountWidgetTiles,
  removeTileController,
} from './tile-controller.js';

const hostServices = createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
const pluginContextServices = {
  locale: hostServices.locale,
  palette: hostServices.palette,
  telemetry: hostServices.telemetry,
  telemetryGathering: hostServices.telemetryGathering,
  eventStream: hostServices.eventStream,
  navigation: () => ({
    pageTable: {baseRouteOf: () => undefined, pluginNameOf: () => undefined},
    navigate: () => undefined,
  }),
};

const emptyBackend = {routes: {}};

function widgetPlugin(
  name: string,
  createInstance: (container: HTMLElement, context: PluginContext) => PluginInstance | Promise<PluginInstance>,
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

  return {entry, module: {createInstance: (container, context) => createInstance(container, context)}};
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
    retryPluginLoad.mockReset();
    replacePluginLoadStates([]);
    setPluginLoadListOutcome('pending');
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
    replacePluginLoadStates([]);
    setPluginLoadListOutcome('pending');
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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

  it('sets the host theme on the plugin body and updates it until removal', () => {
    const priorTheme = getTheme();

    setTheme('dark');
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', vi.fn());
    const body = controller?.body;

    expect(body?.dataset.theme).toBe('dark');
    setTheme('light');
    expect(body?.dataset.theme).toBe('light');

    removeTileController('widget-clock:1');
    setTheme('dark');
    expect(body?.dataset.theme).toBe('light');
    setTheme(priorTheme);
  });

  it('updates the tile title and close aria-label via setTileTitle', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('clock', noop));

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'clock', 'clock:1', vi.fn());

    controller?.setTileTitle('eth0');

    expect(controller?.frame.querySelector('.mndw-grid-tile__title')?.textContent).toBe('eth0');
    expect(controller?.frame.querySelector('.mndw-grid-tile__close')?.getAttribute('aria-label')).toBe('Remove clock');
    expect(controller?.frame.querySelector('.mndw-grid-tile__close mndw-icon')?.getAttribute('name')).toBe('x');

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

  it('marks per-tile dependency notices with live status roles', () => {
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'installing'}]);

    const installing = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', vi.fn());

    expect(installing?.body.querySelector('.mndw-grid-tile__notice')?.getAttribute('role')).toBe('status');

    destroyAllTiles();
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('traffic', noop));
    replaceDepsStatuses([{name: 'traffic', depsStatus: 'failed'}]);

    const failed = ensureTileController(pluginContextServices, pluginRegistry, 'traffic', 'traffic:2', vi.fn());

    expect(failed?.body.querySelector('.mndw-grid-tile__notice')?.getAttribute('role')).toBe('alert');
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

  it('shows failed plugin controls and retries the same tile controller', async () => {
    const entry = widgetPlugin('retry', noop).entry;
    const onRemove = vi.fn();
    let resolveRetry: ((loaded: boolean) => void) | undefined;

    replacePluginLoadStates([entry]);
    setPluginLoadState('retry', 'failed');
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    retryPluginLoad.mockImplementation(() =>
      new Promise<boolean>((resolve) => {
        resolveRetry = resolve;
      })
    );

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'retry', 'retry:1', onRemove);
    const frame = controller?.frame;
    const notice = controller?.body.querySelector<HTMLElement>('[role="alert"]');
    const retryButton = notice?.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry');

    expect(notice?.querySelector('h3')?.textContent).toBe('Plugin “retry” failed to load');
    expect(retryButton?.textContent).toBe('Retry');
    expect(retryButton?.disabled).toBe(false);
    expect(notice?.querySelector('.mndw-grid-tile__remove-failed')?.textContent).toBe('Remove');

    retryButton?.click();

    expect(retryPluginLoad).toHaveBeenCalledWith('retry');
    expect(retryButton?.disabled).toBe(true);
    expect(notice?.getAttribute('aria-busy')).toBe('true');

    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('retry', noop));
    setPluginLoadState('retry', 'loaded');
    refreshPluginLoadPlaceholders(pluginContextServices, pluginRegistry);
    resolveRetry?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller?.frame).toBe(frame);
    expect(controller?.pluginLoadPlaceholder).toBe(false);
    expect(controller?.body.querySelector('[role="alert"]')).toBeNull();
    expect(mountWidgetTile).toHaveBeenCalledTimes(1);

    const mountedHandle = mountWidgetTile.mock.results[0]?.value as {dispose: ReturnType<typeof vi.fn>};

    removeTileController('widget-retry:1');

    expect(mountedHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('shows a mount failure and retries with a fresh context', async () => {
    const contexts: PluginContext[] = [];
    const handles: Array<{dispose: ReturnType<typeof vi.fn>}> = [];

    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('mount-retry', (container, context) => {
      contexts.push(context);

      if (contexts.length === 1) {
        return Promise.reject(new Error('initialization failed'));
      }

      container.textContent = 'Mounted after retry';

      return noop();
    }));
    mountWidgetTile.mockImplementation((body: HTMLElement, plugin: LoadedPlugin, context: unknown) => {
      const result = plugin.module.createInstance(body, (context as {context: PluginContext}).context);
      const ready = Promise.resolve(result).then(
        () => true,
        () => {
          body.textContent = 'Error loading widget';

          return false;
        },
      );
      const dispose = vi.fn();
      const handle = {
        getMounted: vi.fn(() => null),
        whenReady: vi.fn(() => ready),
        dispose,
      };

      handles.push(handle);

      return handle;
    });

    const controller = ensureTileController(
      pluginContextServices,
      pluginRegistry,
      'mount-retry',
      'mount-retry:1',
      vi.fn(),
    );

    await Promise.resolve();
    await Promise.resolve();

    const notice = controller?.body.querySelector<HTMLElement>('[role="alert"]');
    const retryButton = notice?.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry');
    const firstContext = mountWidgetTile.mock.calls[0]?.[2];

    expect(notice?.querySelector('h3')?.textContent).toBe('Plugin “mount-retry” failed to load');
    expect(retryButton?.textContent).toBe('Retry');

    retryButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller?.body.textContent).toBe('Mounted after retry');
    expect(mountWidgetTile).toHaveBeenCalledTimes(2);
    expect(contexts[1]).not.toBe(contexts[0]);
    expect(handles[0]?.dispose).toHaveBeenCalledOnce();
    expect(mountWidgetTile.mock.calls[1]?.[2]).not.toBe(firstContext);
  });

  it('uses sandbox retry for failed plugin placeholders in sandbox mode', async () => {
    vi.stubGlobal('__MNDW_SANDBOX__', 'virtual');
    replacePluginLoadStates([widgetPlugin('sandbox-retry', noop).entry]);
    setPluginLoadState('sandbox-retry', 'failed');
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);

    const controller = ensureTileController(
      pluginContextServices,
      pluginRegistry,
      'sandbox-retry',
      'sandbox-retry:1',
      vi.fn(),
    );
    const retryButton = controller?.body.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry');

    retryButton?.click();
    await Promise.resolve();

    expect(retrySandboxPlugin).toHaveBeenCalledWith('sandbox-retry');
    expect(retryPluginLoad).not.toHaveBeenCalled();
    removeTileController('widget-sandbox-retry:1');
  });

  it('hydrates concurrent retries once per tile and disposes each mounted handle once', async () => {
    const entry = widgetPlugin('retry', noop).entry;
    let finishRetry: ((loaded: boolean) => void) | undefined;
    const retryResult = new Promise<boolean>((resolve) => {
      finishRetry = resolve;
    });

    replacePluginLoadStates([entry]);
    setPluginLoadState('retry', 'failed');
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    retryPluginLoad.mockReturnValue(retryResult);

    const first = ensureTileController(pluginContextServices, pluginRegistry, 'retry', 'retry:1', vi.fn());
    const second = ensureTileController(pluginContextServices, pluginRegistry, 'retry', 'retry:2', vi.fn());

    first?.body.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry')?.click();
    second?.body.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry')?.click();
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('retry', noop));
    setPluginLoadState('retry', 'loaded');
    refreshPluginLoadPlaceholders(pluginContextServices, pluginRegistry);

    expect(mountWidgetTile).toHaveBeenCalledTimes(2);

    finishRetry?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mountWidgetTile).toHaveBeenCalledTimes(2);

    const firstHandle = mountWidgetTile.mock.results[0]?.value as {dispose: ReturnType<typeof vi.fn>};
    const secondHandle = mountWidgetTile.mock.results[1]?.value as {dispose: ReturnType<typeof vi.fn>};

    removeTileController('widget-retry:1');
    removeTileController('widget-retry:2');

    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(secondHandle.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a retried plugin pending until dependencies become ready', async () => {
    const entry = widgetPlugin('retry', noop).entry;

    replacePluginLoadStates([entry]);
    setPluginLoadState('retry', 'failed');
    replaceDepsStatuses([{name: 'retry', depsStatus: 'installing'}]);
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    retryPluginLoad.mockResolvedValue(true);

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'retry', 'retry:1', vi.fn());

    controller?.body.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry')?.click();
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('retry', noop));
    setPluginLoadState('retry', 'loaded');
    refreshPluginLoadPlaceholders(pluginContextServices, pluginRegistry);

    expect(controller?.pending).toBe(true);
    expect(controller?.body.textContent).toBe('Preparing… installing dependencies');
    expect(mountWidgetTile).not.toHaveBeenCalled();

    replaceDepsStatuses([{name: 'retry', depsStatus: 'ready'}]);
    hydratePendingTiles(pluginContextServices, pluginRegistry);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller?.pending).toBe(false);
    expect(mountWidgetTile).toHaveBeenCalledTimes(1);
  });

  it('shows dependency failure when a retried plugin has failed dependencies', async () => {
    const entry = widgetPlugin('retry', noop).entry;

    replacePluginLoadStates([entry]);
    setPluginLoadState('retry', 'failed');
    replaceDepsStatuses([{name: 'retry', depsStatus: 'failed'}]);
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);
    retryPluginLoad.mockResolvedValue(true);

    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'retry', 'retry:1', vi.fn());

    controller?.body.querySelector<HTMLButtonElement>('.mndw-grid-tile__retry')?.click();
    vi.mocked(pluginRegistry).get.mockReturnValue(widgetPlugin('retry', noop));
    setPluginLoadState('retry', 'loaded');
    refreshPluginLoadPlaceholders(pluginContextServices, pluginRegistry);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller?.pending).toBe(false);
    expect(controller?.body.textContent).toBe('Dependency install failed');
    expect(controller?.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(mountWidgetTile).not.toHaveBeenCalled();
  });

  it('routes failed tile removal through the dashboard callback', () => {
    replacePluginLoadStates([widgetPlugin('retry', noop).entry]);
    setPluginLoadState('retry', 'failed');
    vi.mocked(pluginRegistry).get.mockReturnValue(undefined);

    const onRemove = vi.fn();
    const controller = ensureTileController(pluginContextServices, pluginRegistry, 'retry', 'retry:4', onRemove);

    controller?.body.querySelector<HTMLButtonElement>('.mndw-grid-tile__remove-failed')?.click();

    expect(onRemove).toHaveBeenCalledWith('widget-retry:4');
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
    expect(controller?.body.querySelector('.mndw-grid-tile__notice')?.getAttribute('role')).toBe('alert');
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
