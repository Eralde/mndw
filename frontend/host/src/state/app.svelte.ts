import type {DeviceInfoData, MndwThemeName} from '@mndw/sdk';
import type {HostInfo} from '../runtime/device-info-context.js';
import {mobileMediaQuery} from '../layout/breakpoint.js';
import {getLocale, subscribeLocale, subscribeLocalePending} from '../services/locale.service.js';
import {getTheme, subscribeTheme} from '../services/theme.service.js';
import {stopDepsPolling} from './deps-status.svelte.js';

interface AppState {
  /** True once the device session is confirmed valid. */
  authenticated: boolean;
  /** True once the authenticated shell is built (host info fetched, router created). */
  ready: boolean;
  /** True while the current authenticated initialization is still building the shell. */
  authInitInFlight: boolean;
  /** Remount key for authenticated content after the plugin registry is rebuilt. */
  pluginLoadRevision: number;
  /** Remount key for the alert banner; bumped when a retry fails again so the failure is re-announced. */
  pluginLoadFailureSeq: number;
  hostInfo: HostInfo | null;
  deviceInfo: DeviceInfoData | null;
  /** Host-translated error kind set when the plugin list can't be loaded. */
  pluginLoadError: 'list' | null;
  /**
   * Host-translated message shown on the login form after the authenticated initialization
   * started by a successful login fails. Written from the init-failure path because the
   * LoginPage instance that submitted the credentials is already unmounted by then.
   */
  loginError: string | null;
  /** Username to prefill after such a failure; the password is never kept. */
  loginUsername: string;
  mobileSidebarOpen: boolean;
  desktopSidebarCollapsed: boolean;
  theme: MndwThemeName;
  locale: string;
  localeSwitchPending: boolean;
}

let authRunGeneration = 0;
let authRunController = new AbortController();

/** Starts current authenticated init run and invalidates results from older work. */
export function beginAuthRun(preservePluginLoadError = false): number {
  authRunController.abort();
  authRunController = new AbortController();
  authRunGeneration += 1;

  if (!preservePluginLoadError) {
    appState.pluginLoadError = null;
  }

  appState.authInitInFlight = true;

  return authRunGeneration;
}

export function getAuthRunGeneration(): number {
  return authRunGeneration;
}

export function getAuthRunSignal(): AbortSignal {
  return authRunController.signal;
}

export function finishAuthRun(generation: number): void {
  if (generation === authRunGeneration) {
    appState.authInitInFlight = false;
  }
}

export const appState: AppState = $state({
  authenticated: false,
  ready: false,
  authInitInFlight: false,
  pluginLoadRevision: 0,
  pluginLoadFailureSeq: 0,
  hostInfo: null,
  deviceInfo: null,
  pluginLoadError: null,
  loginError: null,
  loginUsername: '',
  mobileSidebarOpen: false,
  desktopSidebarCollapsed: false,
  theme: getTheme(),
  locale: getLocale(),
  localeSwitchPending: false,
});

export function toggleSidebar(): void {
  if (mobileMediaQuery().matches) {
    appState.mobileSidebarOpen = !appState.mobileSidebarOpen;
  } else {
    appState.desktopSidebarCollapsed = !appState.desktopSidebarCollapsed;
  }
}

/** Resets app to login and stops dependency polling for prior session. */
export function resetToLogin(): void {
  authRunGeneration += 1;
  authRunController.abort();
  authRunController = new AbortController();
  stopDepsPolling();
  appState.authenticated = false;
  appState.ready = false;
  appState.authInitInFlight = false;
  appState.pluginLoadError = null;
  appState.loginError = null;
  appState.loginUsername = '';
  appState.pluginLoadFailureSeq = 0;
  appState.hostInfo = null;
  appState.deviceInfo = null;
}

// Keep the reactive UI mirror in sync with the theme service (source of truth).
subscribeTheme((theme) => {
  appState.theme = theme;
});

subscribeLocale((locale) => {
  appState.locale = locale;
});

subscribeLocalePending((pending) => {
  appState.localeSwitchPending = pending;
});
