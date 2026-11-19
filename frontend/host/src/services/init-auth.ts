import {type LoaderDeps, loadPlugins} from '../runtime/plugin-loader.js';
import {type SandboxLoaderDeps, loadSandboxPlugin} from '../runtime/sandbox-loader.js';
import {sandboxVirtualImports, setupSandboxHmr} from '../runtime/sandbox-virtual.js';
import {type PluginRegistry} from '../runtime/plugin-registry.js';
import {appState, beginAuthRun, finishAuthRun, getAuthRunGeneration} from '../state/app.svelte.js';
import {anyInstalling, startDepsPolling} from '../state/deps-status.svelte.js';
import {fetchDeviceInfo, fetchHostInfo} from './host-info.service.js';
import type {HostServices} from '../host-services.js';

/** `typeof` guards the undefined case (e.g. under vitest). */
function isSandboxMode(): boolean {
  return typeof __MNDW_SANDBOX__ !== 'undefined'
    && (__MNDW_SANDBOX__ === 'virtual' || __MNDW_SANDBOX__ === 'url');
}

export interface InitAuthDeps {
  preservePluginLoadError?: boolean;
  loadPlugins?: (deps: LoaderDeps) => Promise<void>;
  loadSandboxPlugin?: (deps: SandboxLoaderDeps) => Promise<void>;
  setupHmr?: (services: HostServices, isCurrent: () => boolean) => void;
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
 *
 * Resolves with the generation of the run it started, so callers can tell whether the run is
 * still current once it settles (a logout or newer init supersedes it). Undefined when the run
 * exited early because it was superseded.
 */
export async function initAuthenticated(
  services: HostServices,
  deps: InitAuthDeps = {},
): Promise<number | undefined> {
  const generation = beginAuthRun(deps.preservePluginLoadError);
  const isCurrent = (): boolean => generation === getAuthRunGeneration();
  const loadPluginsFn = deps.loadPlugins ?? loadPlugins;
  const loadSandboxPluginFn = deps.loadSandboxPlugin ?? loadSandboxPlugin;
  const createRouterFn = deps.createRouter ?? ((registry) => services.router.create(registry));

  try {
    try {
      const hostInfo = await fetchHostInfo(services.theme, services.locale);

      if (isCurrent()) {
        appState.hostInfo = hostInfo;
      }
    } catch (err) {
      if (isCurrent()) {
        console.error('[mndw] Failed to fetch host info:', err);
      }
    }

    if (!isCurrent()) {
      return;
    }

    try {
      const deviceInfo = await fetchDeviceInfo(services.mgmtClient, services.rci);

      if (isCurrent()) {
        appState.deviceInfo = deviceInfo;
      }
    } catch (err) {
      if (isCurrent()) {
        console.error('[mndw] Failed to fetch device info:', err);
      }
    }

    if (!isCurrent()) {
      return;
    }

    if (isSandboxMode()) {
      let sandboxImports = sandboxVirtualImports;
      let setupHmr: (services: HostServices, isCurrent: () => boolean) => void = deps.setupHmr
        ?? ((hostServices, isRunCurrent) => setupSandboxHmr(hostServices, undefined, undefined, isRunCurrent));

      if (__MNDW_SANDBOX__ === 'url') {
        const sandboxUrl = await import('../runtime/sandbox-url.js');

        if (!isCurrent()) {
          return;
        }

        sandboxImports = sandboxUrl.sandboxUrlImports();
        setupHmr = deps.setupHmr
          ?? ((hostServices, isRunCurrent) => sandboxUrl.setupSandboxUrlHmr(hostServices, undefined, isRunCurrent));
      }

      await loadSandboxPluginFn({
        ...sandboxImports,
        registry: services.registry,
        catalogService: services.catalog,
        pluginStylesheets: services.pluginStylesheets,
        getLocale: () => services.locale.getLocale(),
        isCurrent,
        pluginContextServices: {
          locale: services.locale,
          palette: services.palette,
          telemetry: services.telemetry,
          telemetryGathering: services.telemetryGathering,
          eventStream: services.eventStream,
          rci: services.rci,
          theme: services.theme,
          tickerPool: services.tickerPool,
          overlayRuntime: services.overlayRuntime,
          navigation: () => services.router.navigation(),
        },
      });

      if (!isCurrent()) {
        return;
      }

      setupHmr(services, isCurrent);
    } else {
      await loadPluginsFn({
        registry: services.registry,
        catalogService: services.catalog,
        getLocale: () => services.locale.getLocale(),
        pluginStylesheets: services.pluginStylesheets,
      });

      if (!isCurrent()) {
        return;
      }

      if (anyInstalling()) {
        startDepsPolling();
      }
    }

    if (!isCurrent()) {
      return;
    }

    createRouterFn(services.registry);

    if (!isCurrent()) {
      return;
    }

    appState.ready = true;
  } finally {
    finishAuthRun(generation);
  }

  return generation;
}
