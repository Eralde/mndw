export const STORAGE_PREFIX = 'mndw';
export const PLUGIN_STORAGE_PREFIX = `${STORAGE_PREFIX}:plugin`;

export const API_TIMEOUT_MS = 5000;

/** Daemon management endpoint the runtime loads the plugin list from (design §5.2). */
export const MGMT_LIST_URL = '/api/mgmt/list';

/** URL prefixes plugin assets are served from, by source (design §6). */
export const PLUGIN_SOURCE_PATHS = {
  builtin: '/plugins/',
  user: '/user-plugins/',
} as const;
