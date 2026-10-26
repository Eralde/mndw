import type {RciManager} from '@rci-tools/core';
import type {PluginStorage} from './storage.js';
import type {OverlayService} from './overlay.js';
import type {BackendClient} from './backend-client.js';
import type {PaletteTokenMap} from './palette.js';
import type {MndwThemeName} from './tokens.js';
import type {Observable} from 'rxjs';
import type {PluginI18n} from './i18n.js';
import type {TelemetryClient} from './telemetry-client.js';
import type {PluginEventFacade} from './event-schema.js';

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

export interface HostInfo {
  /** Active UI locale at the time this context was created. */
  locale: string;
  /** Active UI theme at the time this context was created. */
  theme: MndwThemeName;
}

interface PluginContextBase {
  telemetry: TelemetryClient;
  events?: PluginEventFacade;
  rciManager: RciManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  deviceInfo: DeviceInfo;
  i18n: PluginI18n;
  instanceId: string;
  /**
   * Typed backend client. Present only when the plugin declares a `backend`; ids resolve locally
   * from the daemon's descriptor snapshot. See {@link BackendClient}.
   */
  backend?: BackendClient;
  /**
   * Subscribe to host theme changes. The callback fires with the new theme
   * whenever the user toggles it. Returns an unsubscribe function; call it on
   * plugin teardown.
   *
   * For colors, prefer the `--mndw-*` CSS custom properties. Where a color must be
   * computed in JS, use {@link PluginContext.getTokens} — NOT the `MNDW_TOKENS`
   * constant, which is the compiled default palette and ignores any device override.
   */
  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
  /**
   * Resolved color tokens for both themes: the device's imported palette when one is
   * applied, otherwise the compiled defaults. A method rather than a snapshot because
   * the palette can change while a plugin is mounted.
   */
  getTokens(): PaletteTokenMap;
  /**
   * Subscribe to palette changes — an import committed from Settings, a reset, or a
   * live preview. Fires with the newly applied tokens. Returns an unsubscribe
   * function; call it on plugin teardown.
   */
  onPaletteChange(callback: (tokens: PaletteTokenMap) => void): () => void;
  /** Framework-agnostic top-layer UI (modal, drawer, popover, custom). */
  overlay: OverlayService;
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
