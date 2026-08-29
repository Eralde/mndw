import {SETTINGS_TAB_DEFS, type SettingsPath, type SettingsTabId} from './settings-tabs.js';

export {SETTINGS_TAB_DEFS} from './settings-tabs.js';
export type {SettingsPath, SettingsTabId} from './settings-tabs.js';

export const SETTINGS_DEFAULT_TAB: SettingsTabId = 'general';

export function settingsPath(tab: SettingsTabId): SettingsPath {
  return SETTINGS_TAB_DEFS.find((candidate) => candidate.id === tab)?.route ?? `/settings/${tab}`;
}

export function settingsTabFromPath(pathname: string): SettingsTabId | null {
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
