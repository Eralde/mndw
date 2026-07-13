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
export const MGMT_UPLOAD_URL = '/api/mgmt/upload';
export const MGMT_APPROVE_URL = '/api/mgmt/approve';
export const MGMT_DENY_URL = '/api/mgmt/deny';
export const MGMT_ENABLE_URL = '/api/mgmt/enable';
export const MGMT_DISABLE_URL = '/api/mgmt/disable';
export const MGMT_DELETE_URL = '/api/mgmt/delete';

/** URL prefixes plugin assets are served from, by source (design §6). */
export const PLUGIN_SOURCE_PATHS = {
  builtin: '/plugins/',
  user: '/user-plugins/',
} as const;
