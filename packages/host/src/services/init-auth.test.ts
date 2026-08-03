import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./host-info.service.js', () => ({fetchHostInfo: vi.fn()}));
vi.mock('./extender-access.service.js', () => ({
  extenderAccessService: {
    getExtenderAccess: vi.fn().mockResolvedValue({enabled: false}),
    postForget: vi.fn().mockResolvedValue(undefined),
    postCredentials: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../runtime/plugin-loader.js', () => ({loadPlugins: vi.fn()}));
vi.mock('../runtime/sandbox-loader.js', () => ({loadSandboxPlugin: vi.fn()}));
vi.mock('../runtime/sandbox-virtual.js', () => ({
  setupSandboxHmr: vi.fn(),
  sandboxVirtualImports: {importPluginModule: vi.fn(), importManifestModule: vi.fn()},
}));
vi.mock('../router/create-app-router.js', () => ({createAppRouter: vi.fn()}));

import {loadPlugins} from '../runtime/plugin-loader.js';
import {loadSandboxPlugin} from '../runtime/sandbox-loader.js';
import {sandboxVirtualImports, setupSandboxHmr} from '../runtime/sandbox-virtual.js';
import {createAppRouter} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {fetchHostInfo} from './host-info.service.js';
import {extenderAccessService} from './extender-access.service.js';
import {initAuthenticated} from './init-auth.js';

const hostInfo = {
  deviceName: 'Keenetic',
  vendor: 'Keenetic',
  firmwareVersion: '4.0',
  theme: 'dark' as const,
};

describe('initAuthenticated', () => {
  beforeEach(() => {
    appState.ready = false;
    appState.hostInfo = null;
    vi.mocked(fetchHostInfo).mockResolvedValue(hostInfo);
    vi.mocked(loadPlugins).mockResolvedValue(undefined);
    vi.mocked(createAppRouter).mockReturnValue({} as ReturnType<typeof createAppRouter>);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads plugins from the daemon and never touches the sandbox loader in normal mode', async () => {
    await initAuthenticated();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(extenderAccessService).postForget).toHaveBeenCalledTimes(1);
    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(loadSandboxPlugin).not.toHaveBeenCalled();
    expect(setupSandboxHmr).not.toHaveBeenCalled();
  });

  it('loads the sandbox plugin and wires HMR instead of the daemon list in sandbox mode', async () => {
    vi.stubGlobal('__MNDW_SANDBOX__', true);
    vi.mocked(loadSandboxPlugin).mockResolvedValue(undefined);

    await initAuthenticated();

    expect(loadSandboxPlugin).toHaveBeenCalledWith(sandboxVirtualImports);
    expect(setupSandboxHmr).toHaveBeenCalledTimes(1);
    expect(loadPlugins).not.toHaveBeenCalled();
    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
  });

  it('does not wait for optional backend work before making the host ready', async () => {
    let resolveAccess: (state: {enabled: boolean}) => void = () => {};
    const accessRequest = new Promise<{enabled: boolean}>((resolve) => {
      resolveAccess = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getExtenderAccess = vi.mocked(extenderAccessService).getExtenderAccess;

    getExtenderAccess.mockReturnValueOnce(accessRequest);

    const pending = initAuthenticated();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    try {
      expect(appState.ready).toBe(true);
    } finally {
      resolveAccess({enabled: false});
      await pending;
    }
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
    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);

    errorSpy.mockRestore();
  });

  it('continues startup when optional cleanup work fails', async () => {
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const postForget = vi.mocked(extenderAccessService).postForget;

    postForget.mockRejectedValueOnce(new Error('502'));

    await expect(initAuthenticated()).resolves.toBeUndefined();

    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
    expect(warningSpy).toHaveBeenCalled();

    warningSpy.mockRestore();
  });

  it('continues startup when optional credential work fails', async () => {
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getExtenderAccess = vi.mocked(extenderAccessService).getExtenderAccess;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const postCredentials = vi.mocked(extenderAccessService).postCredentials;

    getExtenderAccess.mockResolvedValueOnce({enabled: true});
    postCredentials.mockRejectedValueOnce(new Error('502'));

    await expect(initAuthenticated({username: 'admin', password: 'secret'})).resolves.toBeUndefined();

    expect(loadPlugins).toHaveBeenCalledTimes(1);
    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
    expect(warningSpy).toHaveBeenCalled();

    warningSpy.mockRestore();
  });

  it('still creates the router when the loader records a list failure', async () => {
    // loadPlugins captures list failures internally and resolves; startup must proceed.
    vi.mocked(loadPlugins).mockResolvedValue(undefined);

    await initAuthenticated();

    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
  });
});
