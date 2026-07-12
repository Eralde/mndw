import type {HostInfo, MndwThemeName} from '@mndw/sdk';
import {getTheme, subscribeTheme} from '../services/theme.service.js';

interface AppState {
  /** True once the device session is confirmed valid. */
  authenticated: boolean;
  /** True once the authenticated shell is built (host info fetched, router created). */
  ready: boolean;
  hostInfo: HostInfo | null;
  /** User-facing message set by the plugin loader when the plugin list can't be loaded. */
  pluginLoadError: string | null;
  sidebarCollapsed: boolean;
  theme: MndwThemeName;
}

export const appState: AppState = $state({
  authenticated: false,
  ready: false,
  hostInfo: null,
  pluginLoadError: null,
  sidebarCollapsed: false,
  theme: getTheme(),
});

// Keep the reactive UI mirror in sync with the theme service (source of truth).
subscribeTheme((theme) => {
  appState.theme = theme;
});
