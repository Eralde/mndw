export const STORAGE_PREFIX = 'mndw';
export const PLUGIN_STORAGE_PREFIX = `${STORAGE_PREFIX}:plugin`;

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;

export const API_TIMEOUT_MS = 5000;

/**
 * Host info handed to a plugin context when neither an explicit value
 * nor a fetched `appState.hostInfo` is available (e.g. the host-info
 * RCI call failed at startup). Global `appState.hostInfo` stays nullable
 * so failure/logout remains distinguishable; only plugin-facing contexts
 * substitute this fallback.
 */
export const FALLBACK_HOST_INFO = {
  deviceName: 'Unknown',
  vendor: 'Unknown',
  firmwareVersion: 'Unknown',
  theme: 'dark',
  // Defensive value only; initLocale commits browser locale before runtime contexts exist.
  locale: 'en',
} as const;

/** Daemon management endpoint the runtime loads the plugin list from */
export const MGMT_LIST_URL = '/api/mgmt/list';
export const MGMT_PERMISSION_URL = '/api/mgmt/permission';
export const MGMT_UPLOAD_URL = '/api/mgmt/upload';
export const MGMT_APPROVE_URL = '/api/mgmt/approve';
export const MGMT_DENY_URL = '/api/mgmt/deny';
export const MGMT_ENABLE_URL = '/api/mgmt/enable';
export const MGMT_DISABLE_URL = '/api/mgmt/disable';
export const MGMT_DELETE_URL = '/api/mgmt/delete';
export const MGMT_RESTART_URL = '/api/mgmt/restart';
export const MGMT_RUNTIME_URL = '/api/mgmt/runtime';
export const MGMT_PALETTE_URL = '/api/mgmt/palette';

export const OPKG_LIST_URL = '/api/mgmt/opkg/list';
export const OPKG_INSTALL_URL = '/api/mgmt/opkg/install';
export const OPKG_REMOVE_URL = '/api/mgmt/opkg/remove';
export const OPKG_UPDATE_URL = '/api/mgmt/opkg/update';
export const OPKG_UPGRADE_URL = '/api/mgmt/opkg/upgrade';
export const OPKG_INFO_URL = '/api/mgmt/opkg/info';
export const SERVICE_LIST_URL = '/api/mgmt/service/list';
export const SERVICE_STATUS_URL = '/api/mgmt/service/status';
export const SERVICE_START_URL = '/api/mgmt/service/start';
export const SERVICE_STOP_URL = '/api/mgmt/service/stop';
export const SERVICE_RESTART_URL = '/api/mgmt/service/restart';
export const SERVICE_SET_ENABLED_URL = '/api/mgmt/service/set-enabled';

/** URL prefixes plugin assets are served from, by source */
export const PLUGIN_SOURCE_PATHS = {
  builtin: '/plugins/',
  user: '/user-plugins/',
} as const;
