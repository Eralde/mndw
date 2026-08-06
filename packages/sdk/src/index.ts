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
/**
 * The COMPILED DEFAULT palette. Correct for build-time use and for code with no
 * plugin context, but it does not reflect a device palette override — inside a
 * plugin, use `context.getTokens()` instead.
 */
export { MNDW_SCALE, MNDW_TOKENS } from './tokens.js';
export type { MndwThemeName } from './tokens.js';
export {
  contrastRatio,
  PALETTE_CONTRAST_PAIRS,
  PALETTE_CSS_VARIABLES,
  paletteToCss,
  validateImportedPalette,
} from './palette.js';
export type {
  PaletteContrastPair,
  PaletteContrastWarning,
  PaletteCssVariable,
  PaletteTokenMap,
  PaletteValidation,
  ThemeName,
  TokenName,
} from './palette.js';
export { SDK_VERSION } from './version.js';
