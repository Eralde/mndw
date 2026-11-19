// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./host-info.service.js', () => ({fetchHostInfo: vi.fn(), fetchDeviceInfo: vi.fn()}));
vi.mock('../runtime/plugin-loader.js', () => ({loadPlugins: vi.fn()}));
vi.mock('../runtime/sandbox-loader.js', () => ({loadSandboxPlugin: vi.fn()}));
vi.mock('../runtime/sandbox-virtual.js', () => ({
  setupSandboxHmr: vi.fn(),
  sandboxVirtualImports: {importPluginModule: vi.fn(), importManifestModule: vi.fn()},
}));
vi.mock('../runtime/sandbox-url.js', () => ({
  sandboxUrlImports: vi.fn(() => ({importPluginModule: vi.fn(), importManifestModule: vi.fn()})),
  setupSandboxUrlHmr: vi.fn(),
}));

import {type LoaderDeps, loadPlugins} from '../runtime/plugin-loader.js';
import {loadSandboxPlugin} from '../runtime/sandbox-loader.js';
import {sandboxVirtualImports, setupSandboxHmr} from '../runtime/sandbox-virtual.js';
import {sandboxUrlImports, setupSandboxUrlHmr} from '../runtime/sandbox-url.js';
import {appState} from '../state/app.svelte.js';
import {fetchDeviceInfo, fetchHostInfo} from './host-info.service.js';
import {initAuthenticated} from './init-auth.js';
import {createHostServices} from '../host-services.js';

const hostInfo = {
  locale: 'en',
  theme: 'dark' as const,
};

const deviceInfo = {
  deviceName: 'Keenetic',
  vendor: 'Keenetic',
  manufacturer: 'Keenetic',
  model: 'Hopper',
  series: 'Hopper',
  region: 'WW',
  hwId: 'hopper',
  hwVersion: '1',
  firmwareVersion: '4.0',
  firmwareRelease: '4.0',
  features: [],
  components: [],
  switchports: {list: [], layout: [], hasPortStats: false},
  usb: {ports: []},
};

function testHostServices() {
  return createHostServices({fetch: vi.fn<typeof globalThis.fetch>()});
}

describe('initAuthenticated', () => {
  beforeEach(() => {
    appState.ready = false;
    appState.hostInfo = null;
    appState.deviceInfo = null;
    appState.pluginLoadError = null;
    vi.mocked(fetchHostInfo).mockResolvedValue(hostInfo);
    vi.mocked(fetchDeviceInfo).mockResolvedValue(deviceInfo);
    vi.mocked(loadPlugins).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    globalThis.history.replaceState({}, '', '/');
  });

  it('loads plugins from the daemon and never touches the sandbox loader in normal mode', async () => {
    const services = testHostServices();

    await initAuthenticated(services);

    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(loadSandboxPlugin).not.toHaveBeenCalled();
    expect(setupSandboxHmr).not.toHaveBeenCalled();
    expect(services.router.current).toBeDefined();
  });

  it('loads and routes through the injected host service graph', async () => {
    const services = testHostServices();
    const loaded: LoaderDeps[] = [];
    let routedRegistry: unknown;

    await initAuthenticated(services, {
      loadPlugins: (deps) => {
        loaded.push(deps);

        return Promise.resolve();
      },
      createRouter: (registry) => {
        routedRegistry = registry;
      },
    });

    expect(loaded[0]?.registry).toBe(services.registry);
    expect(loaded[0]?.catalogService).toBe(services.catalog);
    expect(loaded[0]?.getLocale?.()).toBe(services.locale.getLocale());
    expect(routedRegistry).toBe(services.registry);
    expect(fetchDeviceInfo).toHaveBeenCalledWith(services.mgmtClient, services.rci);
  });

  it('loads the sandbox plugin and wires HMR instead of the daemon list in sandbox mode', async () => {
    vi.stubGlobal('__MNDW_SANDBOX__', 'virtual');
    vi.mocked(loadSandboxPlugin).mockResolvedValue(undefined);

    const services = testHostServices();

    await initAuthenticated(services);

    expect(loadSandboxPlugin).toHaveBeenCalledWith(expect.objectContaining({
      ...sandboxVirtualImports,
      registry: expect.anything(),
    }));
    expect(setupSandboxHmr).toHaveBeenCalledTimes(1);

    const hmrRunGuard = vi.mocked(setupSandboxHmr).mock.calls[0]?.[3];

    expect(hmrRunGuard?.()).toBe(true);
    expect(loadPlugins).not.toHaveBeenCalled();
    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);

    await initAuthenticated(services);

    expect(hmrRunGuard?.()).toBe(false);
  });

  it('loads URL sandbox modules and wires URL HMR in the prebuilt dev host', async () => {
    vi.stubGlobal('__MNDW_SANDBOX__', 'url');
    vi.mocked(loadSandboxPlugin).mockResolvedValue(undefined);

    const services = testHostServices();

    await initAuthenticated(services);

    expect(sandboxUrlImports).toHaveBeenCalledTimes(1);
    expect(loadSandboxPlugin).toHaveBeenCalledWith(expect.objectContaining({
      importPluginModule: expect.any(Function),
      importManifestModule: expect.any(Function),
    }));
    expect(setupSandboxUrlHmr).toHaveBeenCalledTimes(1);
    expect(setupSandboxHmr).not.toHaveBeenCalled();
    expect(loadPlugins).not.toHaveBeenCalled();
    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);
  });

  it('loads plugins before creating the router and only then marks ready', async () => {
    let resolveLoad!: () => void;

    vi.mocked(loadPlugins).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const services = testHostServices();
    const pending = initAuthenticated(services);

    // Let the awaited host-info settle so we are parked on loadPlugins.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(services.router.current).toBeUndefined();
    expect(appState.ready).toBe(false);

    resolveLoad();
    await pending;

    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);
  });

  it('builds a graph router during a ready-state retry', async () => {
    appState.ready = true;
    const services = testHostServices();

    await initAuthenticated(services);

    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);
  });

  it('drops host info and router work from an older init run', async () => {
    let finishFirstHostInfo: (value: typeof hostInfo) => void = () => {};
    const olderHostInfo = {locale: 'en', theme: 'dark' as const};
    const newerHostInfo = {locale: 'ru', theme: 'light' as const};

    vi.mocked(fetchHostInfo)
      .mockImplementationOnce(() =>
        new Promise((resolve) => {
          finishFirstHostInfo = resolve;
        })
      )
      .mockResolvedValueOnce(newerHostInfo);

    const services = testHostServices();
    const olderRun = initAuthenticated(services);
    await initAuthenticated(services);
    finishFirstHostInfo(olderHostInfo);
    await olderRun;

    expect(appState.hostInfo).toEqual(newerHostInfo);
    expect(fetchDeviceInfo).toHaveBeenCalledTimes(1);
    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);
  });

  it('continues startup when fetching host info fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(fetchHostInfo).mockRejectedValue(new Error('rci down'));

    const services = testHostServices();

    await initAuthenticated(services);

    expect(errorSpy).toHaveBeenCalled();
    expect(appState.hostInfo).toBeNull();
    expect(appState.deviceInfo).toEqual(deviceInfo);
    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);

    errorSpy.mockRestore();
  });

  it('continues startup when fetching device info fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(fetchDeviceInfo).mockRejectedValue(new Error('device info down'));

    const services = testHostServices();

    await initAuthenticated(services);

    expect(errorSpy).toHaveBeenCalled();
    expect(appState.deviceInfo).toBeNull();
    expect(loadPlugins).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('still creates the router when the loader records a list failure', async () => {
    // loadPlugins captures list failures internally and resolves; startup must proceed.
    vi.mocked(loadPlugins).mockImplementation(() => {
      appState.pluginLoadError = 'list';

      return Promise.resolve();
    });

    const services = testHostServices();

    await initAuthenticated(services);

    expect(services.router.current).toBeDefined();
    expect(appState.ready).toBe(true);
    expect(appState.pluginLoadError).toBe('list');
  });
});
