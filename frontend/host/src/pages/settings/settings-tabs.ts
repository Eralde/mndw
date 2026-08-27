export type SettingsTab = 'general' | 'diagnostics' | 'plugins';
export type SettingsPath = `/settings/${SettingsTab}`;

export interface SettingsTabDef {
  readonly id: SettingsTab;
  readonly route: SettingsPath;
  readonly labelKey: string;
  readonly icon: string;
}

export const SETTINGS_TAB_DEFS = [
  {id: 'general', route: '/settings/general', labelKey: 'settings.general-tab', icon: 'settings'},
  {id: 'diagnostics', route: '/settings/diagnostics', labelKey: 'settings.diagnostics-tab', icon: 'diagnostics'},
  {id: 'plugins', route: '/settings/plugins', labelKey: 'settings.plugins-tab', icon: 'plugins'},
] as const satisfies readonly SettingsTabDef[];
