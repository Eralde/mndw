export const STORAGE_PREFIX = 'mndw';
export const PLUGIN_STORAGE_PREFIX = `${STORAGE_PREFIX}:plugin`;

export const API_TIMEOUT_MS = 5000;

/**
 * Host info handed to a plugin context when neither an explicit value nor a fetched
 * `appState.hostInfo` is available (e.g. the host-info RCI call failed at startup).
 * Global `appState.hostInfo` stays nullable so failure/logout remains distinguishable;
 * only plugin-facing contexts substitute this fallback (design §"Page Plugins And Startup").
 */
export const FALLBACK_HOST_INFO = {
  deviceName: 'Unknown',
  vendor: 'Unknown',
  firmwareVersion: 'Unknown',
  theme: 'dark',
} as const;

/** Daemon management endpoint the runtime loads the plugin list from (design §5.2). */
export const MGMT_LIST_URL = '/api/mgmt/list';

/** URL prefixes plugin assets are served from, by source (design §6). */
export const PLUGIN_SOURCE_PATHS = {
  builtin: '/plugins/',
  user: '/user-plugins/',
} as const;
