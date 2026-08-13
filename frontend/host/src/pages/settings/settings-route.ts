import {SETTINGS_TAB_DEFS, type SettingsPath, type SettingsTab} from './settings-tabs.js';

export {SETTINGS_TAB_DEFS, SETTINGS_TABS} from './settings-tabs.js';
export type {SettingsPath, SettingsTab} from './settings-tabs.js';

export const SETTINGS_DEFAULT_TAB: SettingsTab = 'general';

export function settingsPath(tab: SettingsTab): SettingsPath {
  return SETTINGS_TAB_DEFS.find((candidate) => candidate.id === tab)?.route ?? `/settings/${tab}`;
}

export function settingsTabFromPath(pathname: string): SettingsTab | null {
  const normalizedPathname = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;

  for (const tab of SETTINGS_TAB_DEFS) {
    if (normalizedPathname === tab.route) {
      return tab.id;
    }
  }

  return null;
}
