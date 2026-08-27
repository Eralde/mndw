import type {
  PluginBackendAccessOutput,
  PluginBackendMethodOutput,
  PluginExecBackendOutput,
  PluginExecRouteOutput,
  PluginHttpRouteOutput,
  PluginManifestOutput,
  PluginPermissionOutput,
  PluginServiceBackendOutput,
  PluginWebSocketRouteOutput,
  WidgetSizeOutput,
} from './manifest-schema.js';

/**
 * Public plugin manifest types derived from the runtime schema.
 *
 * Schema output types include normalized defaults. These aliases preserve
 * source compatibility for callers that omit route access and backend.
 */

export type PluginBackendAccess = PluginBackendAccessOutput;
export type PluginBackendMethod = PluginBackendMethodOutput;
export type PluginPermission = PluginPermissionOutput;

type OptionalDefaultAccess<T> = Omit<T, 'access'> & {access?: PluginBackendAccess};

export type PluginHttpRoute = OptionalDefaultAccess<PluginHttpRouteOutput>;
export type PluginWebSocketRoute = OptionalDefaultAccess<PluginWebSocketRouteOutput>;
export type PluginExecRoute = OptionalDefaultAccess<PluginExecRouteOutput>;

export type PluginExecBackend = Omit<PluginExecBackendOutput, 'routes'> & {routes: PluginExecRoute[]};
export type PluginServiceBackend = Omit<PluginServiceBackendOutput, 'routes'> & {
  routes: Array<PluginHttpRoute | PluginWebSocketRoute>;
};
export type PluginBackend = PluginExecBackend | PluginServiceBackend;

/** Widget size, in grid units on the 12-column dashboard grid. */
export type WidgetSize = WidgetSizeOutput;

export type PluginManifestBase =
  & Omit<Extract<PluginManifestOutput, {type: 'widget'}>, 'type' | 'size' | 'fixedHeight' | 'backend'>
  & {
    type: 'widget' | 'page';
    backend?: PluginBackend;
  };

export type WidgetManifest = Omit<Extract<PluginManifestOutput, {type: 'widget'}>, 'backend'> & {
  backend?: PluginBackend;
};

export type PageManifest = Omit<Extract<PluginManifestOutput, {type: 'page'}>, 'backend'> & {
  backend?: PluginBackend;
};

export type PluginManifest = WidgetManifest | PageManifest;
