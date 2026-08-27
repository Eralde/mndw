import {
  type BackendClient,
  type BackendDescriptor,
  type HostInfo,
  type PageRoute,
  type PluginContext,
  createBackendClient,
} from '@mndw/sdk';
import type {RciManager} from '@rci-tools/core';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {getLocale, subscribeLocale} from '../services/locale.service.js';
import {type PluginCatalogCell, createPluginI18n} from '../services/plugin-catalog.service.js';
import {injector} from '../services/injector.service.js';
import {createPluginOverlayService} from '../services/overlay/overlay-manager.svelte.js';
import {rciService} from '../services/rci.service.js';
import {ScopedPluginStorage} from '../services/storage.service.js';
import {getTokens, subscribePalette} from '../services/palette.service.js';
import {getTheme, subscribeTheme} from '../services/theme.service.js';
import type {HostServices} from '../host-services.js';
import type {PluginListEntry} from './plugin-types.js';
import {createReadonlyInjector, createServiceFacade} from './service-facade.js';

export type OverlayDispose = (reason?: 'plugin-unmount' | 'host-navigation') => void;

export interface PluginContextHandle {
  context: PluginContext;
  dispose: OverlayDispose;
}

// Plugin-facing method allowlists - the full current public surface of each shared
// service (capability parity). This is the seam for future per-plugin scoping.
const RCI_MANAGER_METHODS = [
  'execute',
  'queue',
  'initBackgroundProcess',
  'queueBackgroundProcess',
] as const satisfies readonly (keyof RciManager)[];

/**
 * Constructs the backend client from the list descriptor, or returns undefined when
 * the plugin declares nothing callable (no routes) - a backendless plugin gets no
 * `context.backend`.
 */
function backendClientFor(entry: PluginListEntry): BackendClient | undefined {
  const {routes} = entry.backend;

  if (Object.keys(routes ?? {}).length === 0) {
    return undefined;
  }

  const descriptor: BackendDescriptor = {
    routes: routes ?? {},
    approval: entry.approval,
    enabled: entry.enabled,
  };

  return createBackendClient(entry.name, descriptor);
}

/**
 * Builds the {@link PluginContext} handed to a plugin's `createInstance`.
 * The typed backend client is derived from the daemon list entry's descriptor,
 * so the daemon is authoritative for approval/enabled state and the client maps
 * its error envelope to typed errors.
 */
export interface CreatePluginContextOptions {
  entry: PluginListEntry;
  instanceId: string;
  hostInfo: HostInfo;
  setTileTitle?: (title: string) => void;
  pageRoute?: PageRoute;
  catalogCell?: PluginCatalogCell;
  services?: Pick<HostServices, 'locale' | 'palette'>;
}

export function createPluginContext(options: CreatePluginContextOptions): PluginContextHandle {
  const {entry, instanceId, hostInfo, setTileTitle, pageRoute, catalogCell} = options;
  const getHostLocale = options.services?.locale === undefined
    ? getLocale
    : () => options.services?.locale?.getLocale() ?? getLocale();
  const subscribeHostLocale = options.services?.locale === undefined
    ? (callback: () => void): () => void => subscribeLocale(() => callback())
    : (callback: () => void): () => void => options.services?.locale?.subscribeLocale(() => callback()) ?? (() => {});
  const getPaletteTokens = options.services?.palette === undefined
    ? getTokens
    : () => options.services?.palette?.getTokens() ?? getTokens();
  const subscribeHostPalette = options.services?.palette === undefined
    ? subscribePalette
    : (callback: (tokens: ReturnType<typeof getTokens>) => void): () => void =>
      options.services?.palette?.subscribePalette(callback) ?? (() => {});

  if (entry.type === 'page' && pageRoute === undefined) {
    throw new Error(`Page plugin "${entry.name}" requires a page route`);
  }

  const {service, dispose} = createPluginOverlayService(entry.name, instanceId);

  const variant = entry.type === 'page'
    ? (() => {
      if (pageRoute === undefined) {
        throw new Error(`Page plugin "${entry.name}" requires a page route`);
      }

      return {kind: 'page' as const, pageRoute};
    })()
    : setTileTitle === undefined
    ? {kind: 'widget' as const}
    : {kind: 'widget' as const, setTileTitle};
  const context: PluginContext = Object.assign(
    Object.create(null),
    {
      // SDK exposes concrete classes with private fields; runtime facades intentionally contain only
      // public methods, so cast narrowed facades at this plugin-context boundary.
      rciManager: createServiceFacade(rciService.driver, RCI_MANAGER_METHODS) as unknown as PluginContext['rciManager'],
      storage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:instance:${instanceId}:`),
      sharedStorage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:shared:`),
      hostInfo: Object.freeze(
        Object.assign(Object.create(null), {...hostInfo, locale: getHostLocale(), theme: getTheme()}),
      ),
      i18n: createPluginI18n(catalogCell, getHostLocale, subscribeHostLocale),
      injector: createReadonlyInjector(injector),
      instanceId,
      backend: backendClientFor(entry),
      onThemeChange: subscribeTheme,
      getTokens: getPaletteTokens,
      onPaletteChange: subscribeHostPalette,
      overlay: service,
    },
    variant,
  );

  return {context: Object.freeze(context), dispose};
}
