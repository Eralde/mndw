import {createAppRouter} from '../router/create-app-router.js';
import {appState} from '../state/app.svelte.js';
import {fetchHostInfo} from './host-info.service.js';

/**
 * Bring the app up for an authenticated session: fetch device info (best-effort) and
 * build the router, then flag the shell ready. The plugin runtime + dashboard load
 * here in a later phase; for now the shell renders an empty dashboard.
 */
export async function initAuthenticated(): Promise<void> {
  try {
    appState.hostInfo = await fetchHostInfo();
  } catch (err) {
    console.error('[mndw] Failed to fetch host info:', err);
  }

  createAppRouter();
  appState.ready = true;
}
