import type {RciManager, SessionManager} from '@rci-tools/core';
import type {PluginStorage} from './storage.js';
import type {ServiceInjector} from './injector.js';
import type {OverlayService} from './overlay.js';
import type {BackendClient} from './backend-client.js';
import type {PaletteTokenMap} from './palette.js';
import type {MndwThemeName} from './tokens.js';

export interface HostInfo {
  deviceName: string;
  vendor: string;
  firmwareVersion: string;
  /** Active UI theme at the time this context was created. */
  theme: MndwThemeName;
}

export interface PluginContext {
  rciManager: RciManager;
  sessionManager: SessionManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  injector: ServiceInjector;
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
   * For colours, prefer the `--mndw-*` CSS custom properties. Where a colour must be
   * computed in JS, use {@link PluginContext.getTokens} — NOT the `MNDW_TOKENS`
   * constant, which is the compiled default palette and ignores any device override.
   */
  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
  /**
   * Resolved colour tokens for both themes: the device's imported palette when one is
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
