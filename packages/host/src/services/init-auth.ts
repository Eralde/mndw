import {loadPlugins} from '../runtime/plugin-loader.js';
import {createAppRouter} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {fetchHostInfo} from './host-info.service.js';

/**
 * Bring the app up for an authenticated session: fetch device info (best-effort), load
 * the plugin registry from the daemon, build the router from the populated registry,
 * then flag the shell ready. Host info stays nullable on failure so logout remains
 * distinguishable; `loadPlugins` records list failures itself and always resolves, so a
 * plugin-list failure never blocks router creation.
 */
export async function initAuthenticated(): Promise<void> {
  try {
    appState.hostInfo = await fetchHostInfo();
  } catch (err) {
    console.error('[mndw] Failed to fetch host info:', err);
  }

  await loadPlugins();

  createAppRouter();
  appState.ready = true;
}
