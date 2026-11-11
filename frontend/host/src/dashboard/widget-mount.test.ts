// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../runtime/plugin-lifecycle.js', () => ({
  mountPluginWithContext: vi.fn(),
}));

vi.mock('../runtime/plugin-context.js', () => ({
  createPluginContext: vi.fn(),
}));

import type {DeviceInfoData, PluginContext} from '@mndw/sdk';
import {FALLBACK_HOST_INFO} from '../constants.js';
import type {HostInfo} from '../runtime/device-info-context.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import {type MountedPlugin, type PluginMountHandle, mountPluginWithContext} from '../runtime/plugin-lifecycle.js';
import {type LoadedPlugin, pluginRegistry} from '../runtime/plugin-registry.js';
import type {WidgetListEntry} from '../runtime/plugin-types.js';
import {appState} from '../state/app.svelte.js';
import {createHostServices} from '../host-services.js';
import {hostT} from '../services/locale.service.js';
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

function fakeMounted(): MountedPlugin {
  return {pluginName: 'traffic', instanceId: 'traffic:1', instance: {unmount: vi.fn()}};
}

function fakeMountHandle(mounted: MountedPlugin | null): PluginMountHandle {
  return {
    getMounted: () => mounted,
    dispose: vi.fn(),
    whenReady: () => Promise.resolve(mounted !== null),
  };
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
    vi.mocked(mountPluginWithContext).mockReset();
    dispose.mockClear();
  });

  it('requests the localized widget error text from the shared lifecycle primitive', () => {
    const mountHandle = fakeMountHandle(fakeMounted());

    vi.mocked(mountPluginWithContext).mockReturnValue(mountHandle);

    const container = document.createElement('div');

    const tileHandle = mountWidgetTile(container, plugin, handle);

    expect(tileHandle).toBe(mountHandle);
    expect(mountPluginWithContext).toHaveBeenCalledWith(container, plugin, handle, {
      errorText: hostT('dashboard.widget-error'),
    });
  });

  it('forwards teardown options to the shared lifecycle handle', () => {
    const mounted = fakeMounted();
    const mountHandle = fakeMountHandle(mounted);

    vi.mocked(mountPluginWithContext).mockReturnValue(mountHandle);

    const container = document.createElement('div');
    const tileHandle = mountWidgetTile(container, plugin, handle);

    expect(tileHandle.getMounted()).toBe(mounted);

    tileHandle.dispose({clearStorage: true, closeReason: 'plugin-unmount'});

    expect(mountHandle.dispose).toHaveBeenCalledWith({
      clearStorage: true,
      closeReason: 'plugin-unmount',
    });
  });

  it('delegates pending mount disposal without keeping duplicate state', () => {
    const mountHandle = fakeMountHandle(null);

    vi.mocked(mountPluginWithContext).mockReturnValue(mountHandle);

    const tileHandle = mountWidgetTile(document.createElement('div'), plugin, handle);

    tileHandle.dispose({clearStorage: false, closeReason: 'host-navigation'});

    expect(tileHandle).toBe(mountHandle);
    expect(mountHandle.dispose).toHaveBeenCalledWith({clearStorage: false, closeReason: 'host-navigation'});
  });
});
