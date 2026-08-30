export type SettingsTabId = 'general' | 'diagnostics' | 'plugins' | 'self-update';
export type SettingsPath = `/settings/${SettingsTabId}`;

export interface SettingsTab {
  readonly id: SettingsTabId;
  readonly route: SettingsPath;
  readonly labelKey: string;
  readonly icon: string;
}

export const SETTINGS_TAB_DEFS = [
  {id: 'general', route: '/settings/general', labelKey: 'settings.general-tab', icon: 'settings'},
  {id: 'diagnostics', route: '/settings/diagnostics', labelKey: 'settings.diagnostics-tab', icon: 'diagnostics'},
  {id: 'plugins', route: '/settings/plugins', labelKey: 'settings.plugins-tab', icon: 'plugins'},
  {id: 'self-update', route: '/settings/self-update', labelKey: 'settings.self-update-tab', icon: 'refresh'},
] as const satisfies readonly SettingsTab[];
