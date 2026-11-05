import {type LoaderDeps, loadPlugins} from '../runtime/plugin-loader.js';
import {type SandboxLoaderDeps, loadSandboxPlugin} from '../runtime/sandbox-loader.js';
import {sandboxVirtualImports, setupSandboxHmr} from '../runtime/sandbox-virtual.js';
import {type PluginRegistry} from '../runtime/plugin-registry.js';
import {createAppRouter} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {anyInstalling, startDepsPolling} from '../state/deps-status.svelte.js';
import {fetchDeviceInfo, fetchHostInfo} from './host-info.service.js';
import {type HostServices, defaultHostServices} from '../host-services.js';

/** `typeof` guards the undefined case (e.g. under vitest). */
function isSandboxMode(): boolean {
  return typeof __MNDW_SANDBOX__ !== 'undefined'
    && (__MNDW_SANDBOX__ === 'virtual' || __MNDW_SANDBOX__ === 'url');
}

export interface InitAuthDeps {
  loadPlugins?: (deps: LoaderDeps) => Promise<void>;
  loadSandboxPlugin?: (deps: SandboxLoaderDeps) => Promise<void>;
  setupHmr?: (services: HostServices) => void;
  createRouter?: (registry: Pick<PluginRegistry, 'getPages'>) => void;
}

/**
 * Bring the app up for an authenticated session: fetch host/device info (best-effort), populate
 * the plugin registry, build the router from it, then flag the shell ready. Host info stays
 * nullable on failure so logout remains distinguishable.
 *
 * In normal mode plugins are loaded from the daemon list (`loadPlugins` records list failures
 * itself and always resolves, so a list failure never blocks router creation). Under
 * `mndw dev` (the `__MNDW_SANDBOX__` build flag) the single plugin under development is loaded
 * from source and HMR is wired instead. A prebuilt dev host uses URL-served modules.
 */
export async function initAuthenticated(
  services: HostServices = defaultHostServices(),
  deps: InitAuthDeps = {},
): Promise<void> {
  const loadPluginsFn = deps.loadPlugins ?? loadPlugins;
  const loadSandboxPluginFn = deps.loadSandboxPlugin ?? loadSandboxPlugin;
  const createRouterFn = deps.createRouter ?? createAppRouter;

  try {
    appState.hostInfo = await fetchHostInfo();
  } catch (err) {
    console.error('[mndw] Failed to fetch host info:', err);
  }

  try {
    appState.deviceInfo = await fetchDeviceInfo(services.mgmtClient);
  } catch (err) {
    console.error('[mndw] Failed to fetch device info:', err);
  }

  if (isSandboxMode()) {
    let sandboxImports = sandboxVirtualImports;
    let setupHmr: (services: HostServices) => void = deps.setupHmr ?? setupSandboxHmr;

    if (__MNDW_SANDBOX__ === 'url') {
      const sandboxUrl = await import('../runtime/sandbox-url.js');

      sandboxImports = sandboxUrl.sandboxUrlImports();
      setupHmr = deps.setupHmr ?? sandboxUrl.setupSandboxUrlHmr;
    }

    await loadSandboxPluginFn({
      ...sandboxImports,
      registry: services.registry,
      catalogService: services.catalog,
      getLocale: () => services.locale.getLocale(),
    });
    setupHmr(services);
  } else {
    await loadPluginsFn({
      registry: services.registry,
      catalogService: services.catalog,
      getLocale: () => services.locale.getLocale(),
    });

    if (anyInstalling()) {
      startDepsPolling();
    }
  }

  createRouterFn(services.registry);
  appState.ready = true;
}
