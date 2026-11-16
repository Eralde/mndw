/**
 * Asynchronous key/value storage for plugin data.
 *
 * Values currently live in this browser's `localStorage` for the dashboard origin. They are local to this browser
 * and device, do not sync to other browsers or devices, and are lost when site data is cleared. Private-window data
 * may be discarded when the private session ends. Values are not included in mndw backups, and plugin backends
 * cannot read them.
 *
 * This is not a security boundary. The key prefix is a convention; other plugins on the same origin can read the
 * values. The browser's `localStorage` quota (usually a few MB) is shared by the host and all plugins. Store small
 * values, not secrets.
 *
 * Methods are asynchronous so storage can move to the device later without an API change.
 */
export interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
