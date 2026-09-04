export type {MndwPlugin, PluginInstance, PluginResizeSize} from './plugin.js';
export {PageRouteError} from './context.js';
export type {
  DeviceInfo,
  DeviceInfoData,
  DeviceUsb,
  HostInfo,
  PagePluginContext,
  PageRoute,
  PageRouteErrorCode,
  PluginContext,
  Switchport,
  Switchports,
  WidgetPluginContext,
} from './context.js';
export {parseCapabilityList} from './device-info.js';
export type {PluginI18n, PluginManifestI18n} from './i18n.js';
export type {Translator} from './translator.js';
export type {PluginStorage} from './storage.js';
export type {ServiceInjector} from './injector.js';
export type {LoadState} from './load-state.js';
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
  PluginBackend,
  PluginBackendAccess,
  PluginBackendMethod,
  PluginExecBackend,
  PluginExecRoute,
  PluginHttpRoute,
  PluginManifest,
  PluginManifestBase,
  PluginPermission,
  PluginServiceBackend,
  PluginWebSocketRoute,
  WidgetManifest,
  WidgetSize,
} from './manifest.js';
export {pluginManifestSchema} from './manifest-schema.js';
export type {PluginManifestInput, PluginManifestOutput} from './manifest-schema.js';
export {isReservedPageRoute, RESERVED_PAGE_ROUTES} from './page-routes.js';
export {classifyMwsMemberEligibility, mwsMemberSchema, normalizeMwsMemberFqdn} from './mws-member-schema.js';
export type {MwsMember, MwsMemberEligibility, MwsMemberEligibilityReason} from './mws-member-schema.js';
export {ManifestValidationError, validateManifest} from './manifest-validator.js';
export {
  BackendBadGateway,
  BackendBlocked,
  BackendDisabled,
  BackendIncompatible,
  BackendMaintenance,
  BackendNotApproved,
  BackendStarting,
  BackendStatusQueryError,
  BackendTransportMismatch,
  BackendUnavailable,
  BackendUnknownId,
  createBackendClient,
  isBackendMaintenanceClose,
} from './backend-client.js';
export type {
  BackendApprovalStatus,
  BackendBlocker,
  BackendClient,
  BackendClientDeps,
  BackendDescriptor,
  BackendFetchOptions,
  BackendRouteDescriptor,
  BackendSocketOptions,
  BackendStatus,
  BackendStatusOptions,
  BackendStatusState,
} from './backend-client.js';
export {
  pluginDependencies,
  SHARED_DEPENDENCIES,
  sharedDependencyVersions,
  sharedImportMap,
  sharedSpecifiers,
  versionedBundleUrl,
} from '../shared-dependencies.js';
export type {DependencyConsumer, SharedDependency} from '../shared-dependencies.js';
/**
 * The COMPILED DEFAULT palette. Correct for build-time use and for code with no
 * plugin context, but it does not reflect a device palette override — inside a
 * plugin, use `context.getTokens()` instead.
 */
export {MNDW_SCALE, MNDW_TOKENS} from './tokens.js';
export type {MndwThemeName} from './tokens.js';
export {createTelemetryClient, TelemetryError} from './telemetry-client.js';
export type {
  ProjectedBand,
  ProjectedBandPoint,
  ProjectedChartColor,
  ProjectedPoint,
  ProjectedSegment,
  ProjectedSeries,
  ProjectedSnapshot,
  ProjectedValueDomain,
  ProjectRange,
  TelemetryClient,
  TelemetrySample,
  TelemetrySeries,
  TelemetrySnapshot,
  TelemetryTier,
} from './telemetry-client.js';
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
export {SDK_VERSION} from './version.js';
