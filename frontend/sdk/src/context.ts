import type {PluginRciManager} from './rci.js';
import type {PluginStorage} from './storage.js';
import type {OverlayService} from './overlay.js';
import type {BackendClient} from './backend-client.js';
import type {PaletteTokenMap} from './palette.js';
import type {MndwThemeName} from './tokens.js';
import type {Observable} from 'rxjs';
import type {PluginI18n} from './i18n.js';
import type {PluginTelemetry} from './telemetry-client.js';
import type {PluginEventFacade} from './event-schema.js';
import type {Ticker} from './ticker.js';

export interface PageRoute {
  readonly childPath$: Observable<string>;
  navigate(
    childPath: string,
    options?: {
      replace?: boolean;
      scrollToTop?: boolean;
    },
  ): Promise<void>;
}

export type PageRouteErrorCode = 'INVALID_PATH' | 'COMPLETED' | 'NAVIGATION_FAILED';

export type HostTarget =
  | {readonly kind: 'dashboard'}
  | {readonly kind: 'packages'}
  | {readonly kind: 'settings'; readonly tab?: 'general' | 'diagnostics' | 'plugins' | 'self-update'}
  | {readonly kind: 'plugin-page'; readonly plugin: string; readonly path?: string};

export interface HostNavigation {
  href(target: HostTarget): string | undefined;
  navigate(target: HostTarget): boolean;
}

export class PageRouteError extends Error {
  public readonly code: PageRouteErrorCode;

  constructor(code: PageRouteErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PageRouteError';
    this.code = code;
  }
}

export interface Switchport {
  /** Stable port key, e.g. "WAN", "LAN1". */
  readonly id: string;
  /** Physical label printed on the case, e.g. "0".."3". */
  readonly label: string;
  readonly index: number;
  /** Port medium, e.g. "ethernet". */
  readonly type: string;
  /** Port group, e.g. "WAN" or "LAN". */
  readonly group: string;
  readonly color: string;
  readonly interfaceId: string;
}

export interface Switchports {
  /** Ordered by `index`. */
  readonly list: readonly Switchport[];
  /** Physical rows of switchport labels for drawing the device body. */
  readonly layout: readonly (readonly string[])[];
  readonly hasPortStats: boolean;
}

export interface DeviceUsb {
  /** USB version per physical port, ordered by physical position. Empty when the device has no USB. */
  readonly ports: readonly ('usb2' | 'usb3')[];
}

/** Plain, serializable device data without context-bound helper methods. */
export interface DeviceInfoData {
  readonly deviceName: string;
  readonly vendor: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly series: string;
  readonly region: string;
  readonly hwId: string;
  readonly hwVersion: string;
  readonly hwType?: string;
  /** show.version.title. */
  readonly firmwareVersion: string;
  /** show.version.release. */
  readonly firmwareRelease: string;
  /** show.version.arch; absent when host information was unavailable. */
  readonly architecture?: string;
  readonly features: readonly string[];
  readonly components: readonly string[];
  readonly switchports: Switchports;
  readonly usb: DeviceUsb;
}

/** Plugin-facing device data with helpers bound to one context snapshot. */
export interface DeviceInfo extends DeviceInfoData {
  hasFeature(name: string): boolean;
  hasComponent(name: string): boolean;
}

interface PluginContextBase {
  /**
   * Aborted with a standard `AbortError` DOMException when the host disposes this context
   * (widget removal, leaving a page, reload, or disable). Pass it to fetch, backend,
   * telemetry, or RCI calls that accept a signal; use it to stop plugin-owned retry and
   * polling loops. Check `signal.aborted` after every await in asynchronous `createInstance` work.
   */
  readonly signal: AbortSignal;
  readonly navigation: HostNavigation;
  readonly telemetry: PluginTelemetry;
  events?: PluginEventFacade;
  rciManager: PluginRciManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  deviceInfo: DeviceInfo;
  i18n: PluginI18n;
  instanceId: string;
  /** Current host theme. This getter follows changes while the plugin is mounted. */
  readonly theme: MndwThemeName;
  /** Emits the current theme on subscribe and completes when the plugin unmounts. */
  readonly theme$: Observable<MndwThemeName>;
  /** Current host locale. This getter follows changes while the plugin is mounted. */
  readonly locale: string;
  /** Emits the current locale on subscribe and completes when the plugin unmounts. */
  readonly locale$: Observable<string>;
  /** Current applied palette, including a device override when present. */
  readonly palette: PaletteTokenMap;
  /** Emits the current palette on subscribe and completes when the plugin unmounts. */
  readonly palette$: Observable<PaletteTokenMap>;
  /**
   * Typed backend client. Present only when the plugin declares a `backend`; ids resolve locally
   * from the daemon's descriptor snapshot. See {@link BackendClient}.
   */
  backend?: BackendClient;
  /** Framework-agnostic top-layer UI (modal, drawer, popover, custom). */
  overlay: OverlayService;
  /** Creates a host-managed ticker destroyed when this plugin context ends. */
  createTicker(): Ticker;
}

export interface WidgetPluginContext extends PluginContextBase {
  readonly kind: 'widget';
  /** Widgets do not receive page navigation. */
  readonly pageRoute?: never;
  /** Set the host tile title. */
  readonly setTileTitle?: (title: string) => void;
}

export interface PagePluginContext extends PluginContextBase {
  readonly kind: 'page';
  /** Navigate within the plugin's page route. */
  readonly pageRoute: PageRoute;
  /** Page plugins do not receive a dashboard tile title setter. */
  readonly setTileTitle?: never;
}

/** Compatibility alias for plugins that consume both widget and page contexts. */
export type PluginContext = WidgetPluginContext | PagePluginContext;
