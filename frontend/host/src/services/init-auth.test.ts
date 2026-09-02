import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./host-info.service.js', () => ({fetchHostInfo: vi.fn(), fetchDeviceInfo: vi.fn()}));
vi.mock('../runtime/plugin-loader.js', () => ({loadPlugins: vi.fn()}));
vi.mock('../runtime/sandbox-loader.js', () => ({loadSandboxPlugin: vi.fn()}));
vi.mock('../runtime/sandbox-virtual.js', () => ({
  setupSandboxHmr: vi.fn(),
  sandboxVirtualImports: {importPluginModule: vi.fn(), importManifestModule: vi.fn()},
}));
vi.mock('../router/create-app-router.js', () => ({createAppRouter: vi.fn()}));

import {type LoaderDeps, loadPlugins} from '../runtime/plugin-loader.js';
import {loadSandboxPlugin} from '../runtime/sandbox-loader.js';
import {sandboxVirtualImports, setupSandboxHmr} from '../runtime/sandbox-virtual.js';
import {createAppRouter} from '../router/create-app-router.js';
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

describe('initAuthenticated', () => {
  beforeEach(() => {
    appState.ready = false;
    appState.hostInfo = null;
    appState.deviceInfo = null;
    vi.mocked(fetchHostInfo).mockResolvedValue(hostInfo);
    vi.mocked(fetchDeviceInfo).mockResolvedValue(deviceInfo);
    vi.mocked(loadPlugins).mockResolvedValue(undefined);
    vi.mocked(createAppRouter).mockReturnValue({} as ReturnType<typeof createAppRouter>);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads plugins from the daemon and never touches the sandbox loader in normal mode', async () => {
    await initAuthenticated();

    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(loadSandboxPlugin).not.toHaveBeenCalled();
    expect(setupSandboxHmr).not.toHaveBeenCalled();
  });

  it('loads and routes through the injected host service graph', async () => {
    const services = createHostServices();
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
    expect(fetchDeviceInfo).toHaveBeenCalledWith(services.mgmtClient);
  });

  it('loads the sandbox plugin and wires HMR instead of the daemon list in sandbox mode', async () => {
    vi.stubGlobal('__MNDW_SANDBOX__', true);
    vi.mocked(loadSandboxPlugin).mockResolvedValue(undefined);

    await initAuthenticated();

    expect(loadSandboxPlugin).toHaveBeenCalledWith(expect.objectContaining({
      ...sandboxVirtualImports,
      registry: expect.anything(),
    }));
    expect(setupSandboxHmr).toHaveBeenCalledTimes(1);
    expect(loadPlugins).not.toHaveBeenCalled();
    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
  });

  it('loads plugins before creating the router and only then marks ready', async () => {
    let resolveLoad!: () => void;

    vi.mocked(loadPlugins).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const pending = initAuthenticated();

    // Let the awaited host-info settle so we are parked on loadPlugins.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(createAppRouter).not.toHaveBeenCalled();
    expect(appState.ready).toBe(false);

    resolveLoad();
    await pending;

    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
  });

  it('continues startup when fetching host info fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(fetchHostInfo).mockRejectedValue(new Error('rci down'));

    await initAuthenticated();

    expect(errorSpy).toHaveBeenCalled();
    expect(appState.hostInfo).toBeNull();
    expect(appState.deviceInfo).toEqual(deviceInfo);
    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);

    errorSpy.mockRestore();
  });

  it('continues startup when fetching device info fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(fetchDeviceInfo).mockRejectedValue(new Error('device info down'));

    await initAuthenticated();

    expect(errorSpy).toHaveBeenCalled();
    expect(appState.deviceInfo).toBeNull();
    expect(loadPlugins).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('still creates the router when the loader records a list failure', async () => {
    // loadPlugins captures list failures internally and resolves; startup must proceed.
    vi.mocked(loadPlugins).mockResolvedValue(undefined);

    await initAuthenticated();

    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
  });
});
