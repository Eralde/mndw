import type {PluginManifestI18n} from './i18n.js';

/**
 * Plugin manifest v3 contracts.
 *
 * Backend commands and service process details stay daemon-local. Host-facing
 * descriptors contain only the route projection exposed by backend-client.ts.
 */

export type PluginBackendAccess = 'session' | 'public';
export type PluginBackendMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PluginHttpRoute {
  id: string;
  transport: 'http';
  method: PluginBackendMethod;
  path: string;
  access?: PluginBackendAccess;
}

export interface PluginWebSocketRoute {
  id: string;
  transport: 'websocket';
  path: string;
  access?: PluginBackendAccess;
  protocols?: string[];
}

export interface PluginExecRoute extends PluginHttpRoute {
  command: string;
}

export interface PluginExecBackend {
  kind: 'exec';
  packages?: string[];
  routes: PluginExecRoute[];
}

export interface PluginServiceBackend {
  kind: 'service';
  protocolVersion: number;
  command: string;
  args?: string[];
  packages?: string[];
  routes: Array<PluginHttpRoute | PluginWebSocketRoute>;
}

export type PluginBackend = PluginExecBackend | PluginServiceBackend;
export type PluginPermission = 'persistent-rci-session:read' | 'persistent-rci-session:write';

export interface PluginManifestBase {
  manifestVersion: 3;
  name: string;
  version: string;
  type: 'widget' | 'page';
  label: string;
  entry: string;
  icon?: string;
  permissions?: PluginPermission[];
  i18n?: PluginManifestI18n;
  backend?: PluginBackend;
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
  fixedHeight?: boolean;
}

export interface PageManifest extends PluginManifestBase {
  type: 'page';
  route: string;
}

export type PluginManifest = WidgetManifest | PageManifest;
