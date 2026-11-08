export type SettingsTabId = 'general' | 'diagnostics' | 'plugins' | 'self-update';

export const HOST_PATHS = {
  dashboard: '/',
  login: '/login',
  packages: '/packages',
  packageServices: '/packages/services',
  settings: '/settings',
  settingsTab: {
    'general': '/settings/general',
    'diagnostics': '/settings/diagnostics',
    'plugins': '/settings/plugins',
    'self-update': '/settings/self-update',
  },
} as const;

export type SettingsPath = (typeof HOST_PATHS.settingsTab)[SettingsTabId];

/** Page-plugin routes currently installed in the router built from a registry snapshot. */
export interface PluginPageTable {
  baseRouteOf(pluginName: string): string | undefined;
  pluginNameOf(baseRoute: string): string | undefined;
}
