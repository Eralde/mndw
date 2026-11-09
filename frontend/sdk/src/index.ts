/** @module @mndw/sdk */
export type {MndwPlugin, PluginInstance, PluginResizeSize} from './plugin.js';
export type {EventSource, EventTopic, MndwEvent, PluginEventFacade} from './event-schema.js';
export {PageRouteError} from './context.js';
export {PLUGIN_RCI_MANAGER_METHODS} from './rci.js';
export type {PluginRciManager, PluginRciManagerMethod} from './rci.js';
export type {
  HostNavigation,
  HostTarget,
  PagePluginContext,
  PageRoute,
  PageRouteErrorCode,
  PluginContext,
  WidgetPluginContext,
} from './context.js';
export type {DeviceInfo, DeviceInfoData, DeviceUsb, Switchport, Switchports} from './context.js';
export type {PluginI18n} from './i18n.js';
export type {Translator} from './translator.js';
export type {PluginStorage} from './storage.js';
export type {Ticker, TickerTick} from './ticker.js';
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
export {
  BackendBadGateway,
  BackendBlocked,
  BackendDisabled,
  BackendError,
  BackendIncompatible,
  BackendMaintenance,
  BackendNotApproved,
  BackendStarting,
  BackendStatusQueryError,
  BackendTransportMismatch,
  BackendUnavailable,
  BackendUnknownId,
  isBackendMaintenanceClose,
} from './backend-client.js';
export type {
  BackendApprovalStatus,
  BackendBlocker,
  BackendClient,
  BackendErrorCode,
  BackendFetchOptions,
  BackendSocketOptions,
  BackendStatus,
  BackendStatusOptions,
  BackendStatusState,
} from './backend-client.js';
/**
 * The COMPILED DEFAULT palette. Correct for build-time use and for code with no
 * plugin context, but it does not reflect a device palette override — inside a
 * plugin, use `context.palette` instead.
 */
export {MNDW_SCALE, MNDW_TOKENS} from './tokens.js';
export type {MndwThemeName} from './tokens.js';
export {historyStatus, isKnownTelemetryUnit, KNOWN_TELEMETRY_UNITS, TelemetryError} from './telemetry-client.js';
export type {
  HistoryStatus,
  KnownTelemetryUnit,
  PluginTelemetry,
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
  TelemetryClock,
  TelemetryClockState,
  TelemetryGathering,
  TelemetryUnit,
} from './telemetry-client.js';
export type {PaletteTokenMap, ThemeName, TokenName} from './palette.js';
export {SDK_VERSION} from './version.js';
