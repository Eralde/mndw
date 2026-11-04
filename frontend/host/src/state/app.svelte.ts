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
  hostInfo: HostInfo | null;
  deviceInfo: DeviceInfoData | null;
  /** User-facing message set by the plugin loader when the plugin list can't be loaded. */
  pluginLoadError: string | null;
  mobileSidebarOpen: boolean;
  desktopSidebarCollapsed: boolean;
  theme: MndwThemeName;
  locale: string;
  localeSwitchPending: boolean;
}

export const appState: AppState = $state({
  authenticated: false,
  ready: false,
  hostInfo: null,
  deviceInfo: null,
  pluginLoadError: null,
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
  stopDepsPolling();
  appState.authenticated = false;
  appState.ready = false;
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
