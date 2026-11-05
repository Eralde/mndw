import {
  type BackendClient,
  type DeviceInfoData,
  PLUGIN_RCI_MANAGER_METHODS,
  type PageRoute,
  type PluginContext,
} from '@mndw/sdk';
import {type BackendDescriptor, createBackendClient} from '@mndw/sdk-internal';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {getLocale, subscribeLocale} from '../services/locale.service.js';
import {type PluginCatalogCell, createPluginI18n} from '../services/plugin-catalog.service.js';
import {createPluginOverlayService} from '../services/overlay/overlay-manager.svelte.js';
import {rciService} from '../services/rci.service.js';
import {ScopedPluginStorage} from '../services/storage.service.js';
import {getTokens, subscribePalette} from '../services/palette.service.js';
import {getTheme, subscribeTheme} from '../services/theme.service.js';
import {type HostServices, defaultHostServices} from '../host-services.js';
import type {PluginListEntry} from './plugin-types.js';
import {createServiceFacade} from './service-facade.js';
import {type HostInfo, createDeviceInfoContext} from './device-info-context.js';
import {createPluginLifetime, hostValue$} from './plugin-lifetime.js';
import {hostTickerPool} from './ticker-pool.js';

export type OverlayDispose = (reason?: 'plugin-unmount' | 'host-navigation') => void;

export interface PluginContextHandle {
  context: PluginContext;
  dispose: OverlayDispose;
}

export type PluginContextServices = Pick<HostServices, 'locale' | 'palette' | 'telemetry' | 'eventStream'>;

let eventFacadeSequence = 0;

const createEventFacadeId = (): string => {
  const cryptoApi = globalThis.crypto;

  return cryptoApi?.randomUUID !== undefined
    ? cryptoApi.randomUUID()
    : `event-context-${++eventFacadeSequence}`;
};

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
  deviceInfo: DeviceInfoData;
  setTileTitle?: (title: string) => void;
  pageRoute?: PageRoute;
  catalogCell?: PluginCatalogCell;
  services?: Partial<PluginContextServices>;
}

export function createPluginContext(options: CreatePluginContextOptions): PluginContextHandle {
  const {entry, instanceId, deviceInfo, setTileTitle, pageRoute, catalogCell} = options;
  const getHostLocale = options.services?.locale === undefined
    ? getLocale
    : () => options.services?.locale?.getLocale() ?? getLocale();
  const subscribeHostLocale = options.services?.locale === undefined
    ? (callback: () => void): () => void => subscribeLocale(() => callback())
    : (callback: () => void): () => void => options.services?.locale?.subscribeLocale(() => callback()) ?? (() => {});
  const getPaletteTokens = options.services?.palette === undefined
    ? getTokens
    : () => options.services?.palette?.getTokens() ?? getTokens();
  const telemetry = options.services?.telemetry ?? defaultHostServices().telemetry;
  const eventStream = options.services?.eventStream ?? defaultHostServices().eventStream;

  if (entry.type === 'page' && pageRoute === undefined) {
    throw new Error(`Page plugin "${entry.name}" requires a page route`);
  }

  const lifetime = createPluginLifetime();
  const theme$ = hostValue$(getTheme, subscribeTheme, lifetime);
  const locale$ = hostValue$(getHostLocale, (callback) =>
    options.services?.locale === undefined
      ? subscribeLocale(callback)
      : options.services.locale.subscribeLocale(callback), lifetime);
  const palette$ = hostValue$(getPaletteTokens, (callback) =>
    options.services?.palette === undefined
      ? subscribePalette(callback)
      : options.services.palette.subscribePalette(callback), lifetime);
  const {service, dispose: disposeOverlay} = createPluginOverlayService(entry.name, instanceId);
  const eventFacadeId = createEventFacadeId();
  const events = eventStream.createFacade(eventFacadeId, entry.name, entry.permissions ?? [], lifetime);
  let disposed = false;
  const dispose: OverlayDispose = (reason) => {
    if (disposed) {
      return;
    }

    disposed = true;
    lifetime.end();

    if (events !== undefined) {
      eventStream.disposeFacade(eventFacadeId);
    }

    disposeOverlay(reason);
  };

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
  const contextBase = Object.assign(Object.create(null) as Record<string, unknown>, {
    telemetry,
    events,
    rciManager: createServiceFacade(rciService.driver, PLUGIN_RCI_MANAGER_METHODS),
    storage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:instance:${instanceId}:`),
    sharedStorage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:shared:`),
    deviceInfo: createDeviceInfoContext(deviceInfo),
    i18n: createPluginI18n(catalogCell, getHostLocale, subscribeHostLocale, lifetime),
    instanceId,
    createTicker: () => hostTickerPool.create(lifetime),
    backend: backendClientFor(entry),
    overlay: service,
    ...variant,
  });

  Object.defineProperties(contextBase, {
    theme: {enumerable: true, get: getTheme},
    theme$: {enumerable: true, value: theme$},
    locale: {enumerable: true, get: getHostLocale},
    locale$: {enumerable: true, value: locale$},
    palette: {enumerable: true, get: getPaletteTokens},
    palette$: {enumerable: true, value: palette$},
  });

  const context = contextBase as unknown as PluginContext;

  return {context: Object.freeze(context), dispose};
}
