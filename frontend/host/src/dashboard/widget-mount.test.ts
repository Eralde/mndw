// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../runtime/plugin-lifecycle.js', () => ({
  mountPlugin: vi.fn(),
  unmountPlugin: vi.fn(),
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn(),
}));

import type {DeviceInfoData, PluginContext} from '@mndw/sdk';
import {FALLBACK_HOST_INFO} from '../constants.js';
import type {HostInfo} from '../runtime/device-info-context.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import {type MountedPlugin, mountPlugin, unmountPlugin} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {appState} from '../state/app.svelte.js';
import {localeService} from '../services/locale.service.js';
import {paletteService} from '../services/palette.service.js';
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
    depsStatus: 'ready',
    backend: {routes: {}},
    type: 'widget',
    size: {w: 4, h: 3},
  };
}

function loadedWidget(name: string): LoadedPlugin {
  return {entry: widgetEntry(name), module: {createInstance: vi.fn()}};
}

const explicitHostInfo: HostInfo = {
  locale: 'en',
  theme: 'light',
};

const explicitDeviceInfo: DeviceInfoData = {
  deviceName: 'Keenetic',
  vendor: 'Keenetic',
  manufacturer: 'Keenetic',
  model: 'Hopper',
  series: 'Hopper',
  region: 'WW',
  hwId: 'id',
  hwVersion: '1',
  firmwareVersion: '4.0',
  firmwareRelease: '4.0',
  features: [],
  components: [],
  switchports: {list: [], layout: [], hasPortStats: false},
  usb: {ports: []},
};

const dispose = vi.fn();
const handle = {context: {instanceId: 'traffic:1'} as PluginContext, dispose};
const pluginContextServices = {locale: localeService, palette: paletteService};

function fakeMounted(): MountedPlugin {
  return {pluginName: 'traffic', instanceId: 'traffic:1', instance: {unmount: vi.fn()}};
}

describe('createWidgetContext', () => {
  beforeEach(() => {
    pluginRegistry.clear();
    appState.hostInfo = null;
    appState.deviceInfo = explicitDeviceInfo;
    vi.mocked(createPluginContext).mockReset();
    vi.mocked(createPluginContext).mockReturnValue(handle);
  });

  afterEach(() => {
    pluginRegistry.clear();
    appState.hostInfo = null;
    appState.deviceInfo = null;
  });

  it('prefers explicit host info over app state and fallback', () => {
    appState.hostInfo = {locale: 'en', theme: 'dark'};

    const plugin = loadedWidget('traffic');

    pluginRegistry.register(plugin);

    createWidgetContext(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', explicitHostInfo);

    expect(createPluginContext).toHaveBeenCalledWith({
      entry: plugin.entry,
      instanceId: 'traffic:1',
      hostInfo: explicitHostInfo,
      deviceInfo: explicitDeviceInfo,
      setTileTitle: undefined,
      catalogCell: undefined,
      services: pluginContextServices,
    });
  });

  it('falls back to app-state host info when none is passed', () => {
    const stateHostInfo: HostInfo = {locale: 'en', theme: 'dark'};

    appState.hostInfo = stateHostInfo;

    const plugin = loadedWidget('traffic');

    pluginRegistry.register(plugin);

    createWidgetContext(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1');

    expect(createPluginContext).toHaveBeenCalledWith({
      entry: plugin.entry,
      instanceId: 'traffic:1',
      hostInfo: stateHostInfo,
      deviceInfo: explicitDeviceInfo,
      setTileTitle: undefined,
      catalogCell: undefined,
      services: pluginContextServices,
    });
  });

  it('falls back to FALLBACK_HOST_INFO when neither explicit nor app-state host info exists', () => {
    const plugin = loadedWidget('traffic');

    pluginRegistry.register(plugin);

    createWidgetContext(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1');

    expect(createPluginContext).toHaveBeenCalledWith({
      entry: plugin.entry,
      instanceId: 'traffic:1',
      hostInfo: FALLBACK_HOST_INFO,
      deviceInfo: explicitDeviceInfo,
      setTileTitle: undefined,
      catalogCell: undefined,
      services: pluginContextServices,
    });
  });

  it('forwards setTileTitle to createPluginContext', () => {
    const plugin = loadedWidget('traffic');
    const setTileTitle = vi.fn();

    pluginRegistry.register(plugin);

    createWidgetContext(pluginContextServices, pluginRegistry, 'traffic', 'traffic:1', explicitHostInfo, setTileTitle);

    expect(createPluginContext).toHaveBeenCalledWith({
      entry: plugin.entry,
      instanceId: 'traffic:1',
      hostInfo: explicitHostInfo,
      deviceInfo: explicitDeviceInfo,
      setTileTitle,
      catalogCell: undefined,
      services: pluginContextServices,
    });
  });

  it('throws when the plugin is not in the registry', () => {
    expect(() => createWidgetContext(pluginContextServices, pluginRegistry, 'missing', 'missing:1')).toThrow(/missing/);
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

    mountWidgetTile(container, plugin, handle);

    expect(mountPlugin).toHaveBeenCalledWith(container, plugin, handle.context, dispose, {
      errorText: 'Error loading widget',
    });
  });

  it('routes sync mounts through unmountPlugin on dispose', () => {
    const mounted = fakeMounted();

    vi.mocked(mountPlugin).mockReturnValue(mounted);

    const container = document.createElement('div');
    const tileHandle = mountWidgetTile(container, plugin, handle);

    expect(tileHandle.getMounted()).toBe(mounted);

    tileHandle.dispose({clearStorage: true, closeReason: 'plugin-unmount'});

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
    const tileHandle = mountWidgetTile(container, plugin, handle);

    tileHandle.dispose({clearStorage: false, closeReason: 'host-navigation'});
    expect(unmountPlugin).not.toHaveBeenCalled();

    resolveMount(mounted);
    await pending;
    await Promise.resolve();

    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, {
      clearStorage: false,
      closeReason: 'host-navigation',
    });
    expect(tileHandle.getMounted()).toBeNull();
  });

  it('unmounts async mounts that resolved before disposal', async () => {
    const mounted = fakeMounted();
    const pending = Promise.resolve<MountedPlugin | null>(mounted);

    vi.mocked(mountPlugin).mockReturnValue(pending);

    const container = document.createElement('div');
    const tileHandle = mountWidgetTile(container, plugin, handle);

    await pending;
    await Promise.resolve();

    expect(tileHandle.getMounted()).toBe(mounted);

    tileHandle.dispose();

    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, undefined);
  });

  it('is idempotent across repeated disposal', () => {
    const mounted = fakeMounted();

    vi.mocked(mountPlugin).mockReturnValue(mounted);

    const container = document.createElement('div');
    const tileHandle = mountWidgetTile(container, plugin, handle);

    tileHandle.dispose({clearStorage: true});
    tileHandle.dispose({clearStorage: false});

    expect(unmountPlugin).toHaveBeenCalledTimes(1);
    expect(unmountPlugin).toHaveBeenCalledWith(mounted, container, {clearStorage: true});
  });
});
