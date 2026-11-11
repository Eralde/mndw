// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./host-info.service.js', () => ({
  fetchHostInfo: vi.fn().mockResolvedValue({locale: 'en', theme: 'dark'}),
  fetchDeviceInfo: vi.fn().mockResolvedValue({
    deviceName: 'Router',
    vendor: 'Vendor',
    manufacturer: 'Vendor',
    model: 'Model',
    series: 'Model',
    region: 'WW',
    hwId: 'router',
    hwVersion: '1',
    firmwareVersion: '1',
    firmwareRelease: '1',
    features: [],
    components: [],
    switchports: {list: [], layout: [], hasPortStats: false},
    usb: {ports: []},
  }),
}));

import {createHostServices} from '../host-services.js';
import {createPluginCatalogService} from './plugin-catalog.service.js';
import {initAuthenticated} from './init-auth.js';
import {loadPlugins} from '../runtime/plugin-loader.js';
import {PluginRegistry} from '../runtime/plugin-registry.js';
import type {PluginListEntry} from '../runtime/plugin-types.js';
import {appState, resetToLogin} from '../state/app.svelte.js';
import {getDepsStatus, replaceDepsStatuses} from '../state/deps-status.svelte.js';

function widget(name: string): PluginListEntry {
  return {
    name,
    type: 'widget',
    version: '1.0.0',
    label: name,
    entry: 'index.js',
    source: 'upload',
    approval: 'approved',
    enabled: true,
    depsStatus: 'failed',
    size: {w: 4, h: 3},
    backend: {routes: {}},
  } as PluginListEntry;
}

function loaderDeps(fetchList: (signal: AbortSignal) => Promise<PluginListEntry[]>, registry: PluginRegistry) {
  return {
    fetchList,
    registry,
    importModule: vi.fn(() => Promise.resolve({createInstance: () => ({unmount() {}})})),
    loadStylesheet: vi.fn(() => Promise.resolve()),
    catalogService: createPluginCatalogService({fetchCatalog: () => Promise.resolve({})}),
  };
}

beforeEach(() => {
  appState.authenticated = true;
  appState.ready = false;
  appState.pluginLoadError = null;
  appState.authInitInFlight = false;
  replaceDepsStatuses([]);
});

afterEach(() => {
  resetToLogin();
  replaceDepsStatuses([]);
  vi.clearAllMocks();
});

describe('plugin load generation', () => {
  it('finishes authenticated init when the plugin list deadline expires', async () => {
    vi.useFakeTimers();

    try {
      const createRouter = vi.fn();
      const services = createHostServices();
      const pending = initAuthenticated(services, {
        loadPlugins: (deps) => loadPlugins({
          ...deps,
          fetchList: () => new Promise(() => {}),
        }),
        createRouter,
      });

      await vi.advanceTimersByTimeAsync(15_000);
      await pending;

      expect(appState.pluginLoadError).toBe('list');
      expect(createRouter).toHaveBeenCalledWith(services.registry);
      expect(appState.ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops pending plugin results when newer authenticated init starts', async () => {
    const registry = new PluginRegistry();
    let finishList: (entries: PluginListEntry[]) => void = () => {};
    const pending = loadPlugins(
      loaderDeps(() => new Promise((resolve) => {
        finishList = resolve;
      }), registry),
    );

    await initAuthenticated(createHostServices(), {
      loadPlugins: () => Promise.resolve(),
      createRouter: () => undefined,
    });
    finishList([widget('stale')]);
    await pending;

    expect(registry.get('stale')).toBeUndefined();
    expect(getDepsStatus('stale')).toBe('ready');
    expect(appState.pluginLoadError).toBeNull();
  });

  it('aborts previous list request when a newer authenticated init starts', async () => {
    let requestSignal: AbortSignal | undefined;
    let finishList: (entries: PluginListEntry[]) => void = () => {};
    const services = createHostServices();
    const pending = initAuthenticated(services, {
      loadPlugins: (deps) => loadPlugins({
        ...deps,
        fetchList: (signal) => new Promise((resolve) => {
          requestSignal = signal;
          finishList = resolve;
        }),
      }),
      createRouter: () => undefined,
    });

    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));
    expect(requestSignal?.aborted).toBe(false);

    await initAuthenticated(createHostServices(), {
      loadPlugins: () => Promise.resolve(),
      createRouter: () => undefined,
    });

    expect(requestSignal?.aborted).toBe(true);
    finishList([]);
    await pending;
  });

  it('ignores late list failure after newer authenticated init starts', async () => {
    const registry = new PluginRegistry();
    let failList: (error: Error) => void = () => {};
    const pending = loadPlugins(
      loaderDeps(() => new Promise((_resolve, reject) => {
        failList = reject;
      }), registry),
    );

    await initAuthenticated(createHostServices(), {
      loadPlugins: () => Promise.resolve(),
      createRouter: () => undefined,
    });
    failList(new Error('late failure'));
    await pending;

    expect(appState.pluginLoadError).toBeNull();
  });

  it('drops pending plugin results after session reset', async () => {
    const registry = new PluginRegistry();
    let requestSignal: AbortSignal | undefined;
    let finishList: (entries: PluginListEntry[]) => void = () => {};
    const pending = loadPlugins(
      loaderDeps((signal) => new Promise((resolve) => {
        requestSignal = signal;
        finishList = resolve;
      }), registry),
    );

    resetToLogin();
    expect(requestSignal?.aborted).toBe(true);
    finishList([widget('logged-out')]);
    await pending;

    expect(registry.get('logged-out')).toBeUndefined();
    expect(getDepsStatus('logged-out')).toBe('ready');
    expect(appState.pluginLoadError).toBeNull();
  });

  it('clears the previous error and busy state across logout and re-login', async () => {
    appState.pluginLoadError = 'list';
    appState.authInitInFlight = true;

    resetToLogin();

    expect(appState.pluginLoadError).toBeNull();
    expect(appState.authInitInFlight).toBe(false);

    appState.authenticated = true;
    let requestSignal: AbortSignal | undefined;
    let finishList: (entries: PluginListEntry[]) => void = () => {};
    const services = createHostServices();
    const pending = initAuthenticated(services, {
      loadPlugins: (deps) => loadPlugins({
        ...deps,
        fetchList: (signal) => new Promise((resolve) => {
          requestSignal = signal;
          finishList = resolve;
        }),
      }),
      createRouter: () => undefined,
    });

    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));
    expect(appState.pluginLoadError).toBeNull();
    expect(appState.authInitInFlight).toBe(true);

    resetToLogin();

    expect(appState.pluginLoadError).toBeNull();
    expect(appState.authInitInFlight).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    finishList([]);
    await pending;
  });

  it('keeps retry error visible and busy until the retried list succeeds', async () => {
    appState.ready = true;
    appState.pluginLoadError = 'list';
    let requestSignal: AbortSignal | undefined;
    let finishList: (entries: PluginListEntry[]) => void = () => {};
    const services = createHostServices();
    const pending = initAuthenticated(services, {
      preservePluginLoadError: true,
      loadPlugins: (deps) => loadPlugins({
        ...deps,
        fetchList: (signal) => new Promise((resolve) => {
          requestSignal = signal;
          finishList = resolve;
        }),
      }),
      createRouter: () => undefined,
    });

    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));
    expect(appState.pluginLoadError).toBe('list');
    expect(appState.authInitInFlight).toBe(true);

    finishList([]);
    await pending;

    expect(appState.pluginLoadError).toBeNull();
    expect(appState.authInitInFlight).toBe(false);
  });
});
