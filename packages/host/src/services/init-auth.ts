import {loadPlugins} from '../runtime/plugin-loader.js';
import {loadSandboxPlugin} from '../runtime/sandbox-loader.js';
import {sandboxVirtualImports, setupSandboxHmr} from '../runtime/sandbox-virtual.js';
import {createAppRouter} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {fetchHostInfo} from './host-info.service.js';

/**
 * Bring the app up for an authenticated session: fetch device info (best-effort), populate
 * the plugin registry, build the router from it, then flag the shell ready. Host info stays
 * nullable on failure so logout remains distinguishable.
 *
 * In normal mode plugins are loaded from the daemon list (`loadPlugins` records list failures
 * itself and always resolves, so a list failure never blocks router creation). Under
 * `mndw dev` (the `__MNDW_SANDBOX__` build flag) the single plugin under development is loaded
 * from source and HMR is wired instead.
 */
export async function initAuthenticated(): Promise<void> {
  try {
    appState.hostInfo = await fetchHostInfo();
  } catch (err) {
    console.error('[mndw] Failed to fetch host info:', err);
  }

  if (isSandboxMode()) {
    await loadSandboxPlugin(sandboxVirtualImports);
    setupSandboxHmr();
  } else {
    await loadPlugins();
  }

  createAppRouter();
  appState.ready = true;
}

/** True only in a `mndw dev` build; `typeof` guards the undefined case (e.g. under vitest). */
function isSandboxMode(): boolean {
  return typeof __MNDW_SANDBOX__ !== 'undefined' && __MNDW_SANDBOX__ === true;
}
