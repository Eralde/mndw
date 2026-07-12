import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../runtime/plugin-lifecycle.js', () => ({
  mountPlugin: vi.fn(),
  unmountPlugin: vi.fn(),
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn(),
}));

import type {HostInfo, PluginContext} from '@mndw/sdk';
import {FALLBACK_HOST_INFO} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import {type MountedPlugin, mountPlugin, unmountPlugin} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {appState} from '../state/app.svelte.js';
import {createWidgetContext} from './widget-context.js';
import {mountWidgetTile} from './widget-mount.js';

function widgetEntry(name: string): WidgetListEntry {
  return {
    name,
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'builtin',
    approval: 'approved',
    enabled: true,
    backend: {endpoints: {}, websockets: {}, opkg: [], daemon: false, public: false},
    type: 'widget',
    size: {w: 4, h: 3},
  };
}

function loadedWidget(name: string): LoadedPlugin {
  return {entry: widgetEntry(name), module: {createInstance: vi.fn()}};
}

const explicitHostInfo: HostInfo = {
  deviceName: 'Keenetic',
  vendor: 'Keenetic',
  firmwareVersion: '4.0',
  theme: 'light',
};

const context = {instanceId: 'traffic:1'} as PluginContext;

function fakeMounted(): MountedPlugin {
  return {pluginName: 'traffic', instanceId: 'traffic:1', instance: {unmount: vi.fn()}};
}

describe('createWidgetContext', () => {
  beforeEach(() => {
    pluginRegistry.clear();
    appState.hostInfo = null;
    vi.mocked(createPluginContext).mockReset();
    vi.mocked(createPluginContext).mockReturnValue(context);
  });

  afterEach(() => {
    pluginRegistry.clear();
    appState.hostInfo = null;
  });

  it('prefers explicit host info over app state and fallback', () => {
    appState.hostInfo = {...explicitHostInfo, deviceName: 'from-state'};

    const plugin = loadedWidget('traffic');

    pluginRegistry.register(plugin);

    createWidgetContext('traffic', 'traffic:1', explicitHostInfo);

    expect(createPluginContext).toHaveBeenCalledWith(plugin.entry, 'traffic:1', explicitHostInfo);
  });

  it('falls back to app-state host info when none is passed', () => {
    const stateHostInfo = {...explicitHostInfo, deviceName: 'from-state'};

    appState.hostInfo = stateHostInfo;

    const plugin = loadedWidget('traffic');

    pluginRegistry.register(plugin);

    createWidgetContext('traffic', 'traffic:1');

    expect(createPluginContext).toHaveBeenCalledWith(plugin.entry, 'traffic:1', stateHostInfo);
  });

  it('falls back to FALLBACK_HOST_INFO when neither explicit nor app-state host info exists', () => {
    const plugin = loadedWidget('traffic');

    pluginRegistry.register(plugin);

    createWidgetContext('traffic', 'traffic:1');

    expect(createPluginContext).toHaveBeenCalledWith(plugin.entry, 'traffic:1', FALLBACK_HOST_INFO);
  });

  it('throws when the plugin is not in the registry', () => {
    expect(() => createWidgetContext('missing', 'missing:1')).toThrow(/missing/);
    expect(createPluginContext).not.toHaveBeenCalled();
  });
});

describe('mountWidgetTile', () => {
  const plugin = {} as LoadedPlugin;

  beforeEach(() => {
    vi.mocked(mountPlugin).mockReset();
    vi.mocked(unmountPlugin).mockReset();
  });

  it('requests the generic "Error loading widget" text from mountPlugin', () => {
    vi.mocked(mountPlugin).mockReturnValue(fakeMounted());

    const container = document.createElement('div');

    mountWidgetTile(container, plugin, context);

    expect(mountPlugin).toHaveBeenCalledWith(container, plugin, context, {
      errorText: 'Error loading widget',
    });
  });

  it('routes sync mounts through unmountPlugin on dispose', () => {
    const mounted = fakeMounted();

    vi.mocked(mountPlugin).mockReturnValue(mounted);

    const container = document.createElement('div');
    const handle = mountWidgetTile(container, plugin, context);

    expect(handle.getMounted()).toBe(mounted);

    handle.dispose({clearStorage: true, closeReason: 'plugin-unmount'});

    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, {
      clearStorage: true,
      closeReason: 'plugin-unmount',
    });
  });

  it('immediately disposes an async mount that resolves after disposal', async () => {
    const mounted = fakeMounted();
    let resolveMount!: (value: MountedPlugin | null) => void;
    const pending = new Promise<MountedPlugin | null>((resolve) => {
      resolveMount = resolve;
    });

    vi.mocked(mountPlugin).mockReturnValue(pending);

    const container = document.createElement('div');
    const handle = mountWidgetTile(container, plugin, context);

    handle.dispose({clearStorage: false, closeReason: 'host-navigation'});
    expect(unmountPlugin).not.toHaveBeenCalled();

    resolveMount(mounted);
    await pending;
    await Promise.resolve();

    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, {
      clearStorage: false,
      closeReason: 'host-navigation',
    });
    expect(handle.getMounted()).toBeNull();
  });

  it('unmounts async mounts that resolved before disposal', async () => {
    const mounted = fakeMounted();
    const pending = Promise.resolve<MountedPlugin | null>(mounted);

    vi.mocked(mountPlugin).mockReturnValue(pending);

    const container = document.createElement('div');
    const handle = mountWidgetTile(container, plugin, context);

    await pending;
    await Promise.resolve();

    expect(handle.getMounted()).toBe(mounted);

    handle.dispose();

    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, undefined);
  });

  it('is idempotent across repeated disposal', () => {
    const mounted = fakeMounted();

    vi.mocked(mountPlugin).mockReturnValue(mounted);

    const container = document.createElement('div');
    const handle = mountWidgetTile(container, plugin, context);

    handle.dispose({clearStorage: true});
    handle.dispose({clearStorage: false});

    expect(unmountPlugin).toHaveBeenCalledTimes(1);
    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, {clearStorage: true});
  });
});
