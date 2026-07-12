import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('./host-info.service.js', () => ({fetchHostInfo: vi.fn()}));
vi.mock('../runtime/plugin-loader.js', () => ({loadPlugins: vi.fn()}));
vi.mock('../router/create-app-router.js', () => ({createAppRouter: vi.fn()}));

import {loadPlugins} from '../runtime/plugin-loader.js';
import {createAppRouter} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {fetchHostInfo} from './host-info.service.js';
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

  it('still creates the router when the loader records a list failure', async () => {
    // loadPlugins captures list failures internally and resolves; startup must proceed.
    vi.mocked(loadPlugins).mockResolvedValue(undefined);

    await initAuthenticated();

    expect(createAppRouter).toHaveBeenCalledTimes(1);
    expect(appState.ready).toBe(true);
  });
});
