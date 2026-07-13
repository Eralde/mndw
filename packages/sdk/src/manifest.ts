/**
 * v2 plugin manifest types (`manifestVersion: 2`).
 *
 * Changes vs v1: widget sizing is in **grid units** (`size: {w, h, minW?, minH?}`) rather than px;
 * backend endpoint/websocket paths are **relative** (the daemon composes the full URL as
 * `/api/plugins/<name>/<path>` / `/ws/plugins/<name>/<path>`); `backend.daemon` formalizes the
 * long-running-process hooks; `backend.public` opts a plugin's endpoints/ws out of the session gate.
 */

export interface PluginBackendScriptDeclaration {
  id: string;
  source: string;
  runtime: 'sh';
}

export interface PluginBackendEndpointDeclaration {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative path; daemon serves it at `/api/plugins/<name>/<path>`. */
  path: string;
  scriptId: string;
}

export interface PluginBackendWebSocketDeclaration {
  id: string;
  /** Relative path; daemon proxies it at `/ws/plugins/<name>/<path>`. */
  path: string;
  target: string;
  protocols?: string[];
}

/** Long-running backend process; start/stop run on enable/disable and device boot. */
export interface PluginBackendDaemonDeclaration {
  start: string;
  stop: string;
}

export interface PluginBackendManifest {
  /** opkg packages the daemon installs on approval. */
  opkg?: string[];
  scripts?: PluginBackendScriptDeclaration[];
  /** Non-script backend files pack must ship verbatim (e.g. compiled binaries). */
  assets?: string[];
  endpoints?: PluginBackendEndpointDeclaration[];
  websockets?: PluginBackendWebSocketDeclaration[];
  daemon?: PluginBackendDaemonDeclaration;
  /** true = endpoints/websockets skip the router-session check (surfaced in the approval UI). */
  public?: boolean;
}

export interface PluginManifestBase {
  manifestVersion: 2;
  name: string;
  version: string;
  type: 'widget' | 'page';
  label: string;
  entry: string;
  icon?: string;
  backend?: PluginBackendManifest;
}

/** Widget size, in grid units on the 12-column dashboard grid. */
export interface WidgetSize {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface WidgetManifest extends PluginManifestBase {
  type: 'widget';
  size: WidgetSize;
}

export interface PageManifest extends PluginManifestBase {
  type: 'page';
  route: string;
}

export type PluginManifest = WidgetManifest | PageManifest;
