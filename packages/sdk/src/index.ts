export type { MndwPlugin, PluginInstance, PluginResizeSize } from './plugin.js';
export type { HostInfo, PluginContext } from './context.js';
export type { PluginStorage } from './storage.js';
export type { ServiceInjector } from './injector.js';
export type {
  OverlayAnchor,
  OverlayCloseEvent,
  OverlayCloseReason,
  OverlayKind,
  OverlayLayer,
  OverlayLayerOptions,
  OverlayMount,
  OverlayOpenOptions,
  OverlayPlacement,
  OverlayService,
  OverlaySession,
} from './overlay.js';
export type {
  PageManifest,
  PluginBackendDaemonDeclaration,
  PluginBackendEndpointDeclaration,
  PluginBackendManifest,
  PluginBackendScriptDeclaration,
  PluginBackendWebSocketDeclaration,
  PluginManifest,
  PluginManifestBase,
  WidgetManifest,
  WidgetSize,
} from './manifest.js';
export { pluginManifestSchema } from './manifest-schema.js';
export type { PluginManifestInput, PluginManifestOutput } from './manifest-schema.js';
export { ManifestValidationError, validateManifest } from './manifest-validator.js';
export { BackendDisabled, BackendNotApproved, BackendUnknownId, createBackendClient } from './backend-client.js';
export type {
  BackendApprovalStatus,
  BackendClient,
  BackendClientDeps,
  BackendDescriptor,
  BackendEndpointDescriptor,
  BackendFetchOptions,
  BackendSocketOptions,
  BackendWebSocketDescriptor,
} from './backend-client.js';
export {
  pluginDependencies,
  SHARED_DEPENDENCIES,
  sharedDependencyVersions,
  sharedImportMap,
  sharedSpecifiers,
  versionedBundleUrl,
} from '../shared-dependencies.js';
export type { DependencyConsumer, SharedDependency } from '../shared-dependencies.js';
export { MNDW_TOKENS } from './tokens.js';
export type { MndwThemeName } from './tokens.js';
