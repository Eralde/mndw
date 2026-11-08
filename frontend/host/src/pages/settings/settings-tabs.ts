import {HOST_PATHS, type SettingsPath, type SettingsTabId} from '../../router/host-routes.js';

export type {SettingsTabId} from '../../router/host-routes.js';
export type {SettingsPath};

export interface SettingsTab {
  readonly id: SettingsTabId;
  readonly route: SettingsPath;
  readonly labelKey: string;
  readonly icon: string;
}

export const SETTINGS_TAB_DEFS = [
  {id: 'general', route: HOST_PATHS.settingsTab.general, labelKey: 'settings.general-tab', icon: 'settings'},
  {
    id: 'diagnostics',
    route: HOST_PATHS.settingsTab.diagnostics,
    labelKey: 'settings.diagnostics-tab',
    icon: 'diagnostics',
  },
  {id: 'plugins', route: HOST_PATHS.settingsTab.plugins, labelKey: 'settings.plugins-tab', icon: 'plugins'},
  {
    id: 'self-update',
    route: HOST_PATHS.settingsTab['self-update'],
    labelKey: 'settings.self-update-tab',
    icon: 'refresh',
  },
] as const satisfies readonly SettingsTab[];
