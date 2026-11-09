import {
  type BackendClient,
  type DeviceInfoData,
  PLUGIN_RCI_MANAGER_METHODS,
  type PageRoute,
  type PluginContext,
  type TelemetryGathering,
} from '@mndw/sdk';
import {type BackendDescriptor, createBackendClient} from '@mndw/sdk-internal';
import {filter} from 'rxjs';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {type PluginCatalogCell, createPluginI18n} from '../services/plugin-catalog.service.js';
import {createPluginOverlayService} from '../services/overlay/overlay-manager.svelte.js';
import {rciService} from '../services/rci.service.js';
import {ScopedPluginStorage} from '../services/storage.service.js';
import {getTheme, subscribeTheme} from '../services/theme.service.js';
import type {HostServices} from '../host-services.js';
import type {PluginListEntry} from './plugin-types.js';
import {createServiceFacade} from './service-facade.js';
import {type HostInfo, createDeviceInfoContext} from './device-info-context.js';
import {createPluginLifetime, hostValue$} from './plugin-lifetime.js';
import {type PluginNavigationRouter, createPluginNavigation} from './plugin-navigation.js';
import {hostTickerPool} from './ticker-pool.js';

export type OverlayDispose = (reason?: 'plugin-unmount' | 'host-navigation') => void;

export interface PluginContextHandle {
  context: PluginContext;
  dispose: OverlayDispose;
}

export type PluginContextServices =
  & Pick<
    HostServices,
    'locale' | 'palette' | 'telemetry' | 'telemetryGathering' | 'eventStream'
  >
  & {
    navigation(): PluginNavigationRouter | undefined;
  };

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
  services: PluginContextServices;
}

export function createPluginContext(options: CreatePluginContextOptions): PluginContextHandle {
  const {entry, instanceId, deviceInfo, setTileTitle, pageRoute, catalogCell, services} = options;
  const getHostLocale = (): string => services.locale.getLocale();
  const subscribeHostLocale = (callback: () => void): () => void => services.locale.subscribeLocale(() => callback());
  const subscribeHostLocaleValue = (callback: (locale: string) => void): () => void =>
    services.locale.subscribeLocale(callback);
  const getPaletteTokens = (): PluginContext['palette'] => services.palette.getTokens();
  const eventStream = services.eventStream;

  if (entry.type === 'page' && pageRoute === undefined) {
    throw new Error(`Page plugin "${entry.name}" requires a page route`);
  }

  const lifetime = createPluginLifetime();
  const theme$ = hostValue$(getTheme, subscribeTheme, lifetime);
  const locale$ = hostValue$(getHostLocale, subscribeHostLocaleValue, lifetime);
  const palette$ = hostValue$(getPaletteTokens, (callback) => services.palette.subscribePalette(callback), lifetime);
  const gathering$ = hostValue$(
    () => services.telemetryGathering.get(),
    (listener) => services.telemetryGathering.subscribe(() => listener(services.telemetryGathering.get())),
    lifetime,
  ).pipe(filter((value): value is TelemetryGathering => value !== null));
  const telemetry = {
    fetchProjected: (...args: Parameters<typeof services.telemetry.fetchProjected>) =>
      services.telemetry.fetchProjected(...args),
    gathering$,
  };
  const {service, dispose: disposeOverlay} = createPluginOverlayService(entry.name, instanceId);
  const eventFacadeId = createEventFacadeId();
  const events = eventStream.createFacade(eventFacadeId, entry.name, entry.permissions ?? [], lifetime);
  let disposed = false;
  const navigation = createPluginNavigation({getRouter: () => services.navigation(), isDisposed: () => disposed});
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
  const context = {
    navigation,
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
    get theme() {
      return getTheme();
    },
    theme$,
    get locale(): string {
      return getHostLocale();
    },
    locale$,
    get palette(): PluginContext['palette'] {
      return getPaletteTokens();
    },
    palette$,
  } satisfies PluginContext;

  Object.setPrototypeOf(context, null);

  return {context: Object.freeze(context), dispose};
}
