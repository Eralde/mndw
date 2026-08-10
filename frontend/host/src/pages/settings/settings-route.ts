export const SETTINGS_TABS = ['general', 'diagnostics', 'plugins'] as const;

export type SettingsTab = typeof SETTINGS_TABS[number];
export type SettingsPath = `/settings/${SettingsTab}`;

export const SETTINGS_DEFAULT_TAB: SettingsTab = 'general';

export function settingsPath(tab: SettingsTab): SettingsPath {
  return `/settings/${tab}`;
}

export function settingsTabFromPath(pathname: string): SettingsTab | null {
  const normalizedPathname = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;

  for (const tab of SETTINGS_TABS) {
    if (normalizedPathname === settingsPath(tab)) {
      return tab;
    }
  }

  return null;
}
