import {
  type BackendClient,
  type DeviceInfoData,
  type PageRoute,
  type PluginContext,
  type PluginToastOptions,
  type PluginToasts,
  type TelemetryGathering,
} from '@mndw/sdk';
import {createPluginTimers} from '@mndw/sdk/internal/timers';
import {
  type BackendDescriptor,
  PLUGIN_RCI_MANAGER_METHODS,
  createBackendClient,
  createPluginRci,
} from '@mndw/sdk-internal';
import {filter} from 'rxjs';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {
  type PluginCatalogCell,
  createPluginI18n,
  getPluginManifestPresentation,
} from '../services/plugin-catalog.service.js';
import {createPluginOverlayService} from '../services/overlay/overlay-manager.svelte.js';
import {toast as toastStore} from '../services/toast/toast.svelte.js';
import {ScopedPluginStorage} from '../services/storage.service.js';
import type {HostServices} from '../host-services.js';
import type {PluginListEntry} from './plugin-types.js';
import {createServiceFacade} from './service-facade.js';
import {type HostInfo, createDeviceInfoContext} from './device-info-context.js';
import {createPluginLifetime, hostValue$} from './plugin-lifetime.js';
import {type PluginNavigationRouter, createPluginNavigation} from './plugin-navigation.js';

export type OverlayDispose = (reason?: 'plugin-unmount' | 'host-navigation') => void;

export interface PluginContextHandle {
  context: PluginContext;
  dispose: OverlayDispose;
}

export type PluginContextServices =
  & Pick<
    HostServices,
    | 'locale'
    | 'palette'
    | 'telemetry'
    | 'telemetryGathering'
    | 'eventStream'
    | 'rci'
    | 'theme'
    | 'tickerPool'
    | 'overlayRuntime'
  >
  & {
    navigation(): PluginNavigationRouter | undefined;
  };

let eventFacadeSequence = 0;
const TOAST_RATE_LIMIT = 8;
const TOAST_RATE_WINDOW_MS = 10_000;

const createEventFacadeId = (): string => {
  const cryptoApi = globalThis.crypto;

  return cryptoApi?.randomUUID !== undefined
    ? cryptoApi.randomUUID()
    : `event-context-${++eventFacadeSequence}`;
};

function createPluginToastFacade(
  entry: Pick<PluginListEntry, 'name' | 'label' | 'description'>,
  instanceId: string,
  catalogCell: PluginCatalogCell | undefined,
  getHostLocale: () => string,
  isDisposed: () => boolean,
): {facade: PluginToasts; dispose: () => void} {
  const pluginName = entry.name;
  const scope = Symbol(`toast:${pluginName}:${instanceId}`);
  const acceptedAt: number[] = [];
  let warnedDisposed = false;
  let warnedRateLimit = false;
  const keyFor = (key: string): string => `plugin:${pluginName}:${instanceId}:${key}`;
  const warnDisposed = (): void => {
    if (warnedDisposed) {
      return;
    }

    warnedDisposed = true;
    console.warn(
      `[mndw] Toast service for "${pluginName}" (${instanceId}) is disposed; the plugin instance was unmounted.`,
    );
  };
  const inertHandle = Object.freeze({dismiss: (): void => {}});
  const show = (options: PluginToastOptions) => {
    if (isDisposed()) {
      warnDisposed();

      return inertHandle;
    }

    const now = Date.now();
    const key = options.key === undefined ? undefined : keyFor(options.key);
    const replacing = key !== undefined && toastStore.toasts.some(
      (current) => current.key === key && current.scope === scope,
    );

    for (let index = acceptedAt.length - 1; index >= 0; index -= 1) {
      if (now - (acceptedAt[index] ?? now) >= TOAST_RATE_WINDOW_MS) {
        acceptedAt.splice(index, 1);
      }
    }

    if (acceptedAt.length < TOAST_RATE_LIMIT) {
      warnedRateLimit = false;
    }

    if (!replacing && acceptedAt.length >= TOAST_RATE_LIMIT) {
      if (!warnedRateLimit) {
        warnedRateLimit = true;
        console.warn(`[mndw] Toast rate limit exceeded for plugin "${pluginName}"; dropping toast.`);
      }

      return inertHandle;
    }

    if (!replacing) {
      acceptedAt.push(now);
    }

    const pluginLabel = getPluginManifestPresentation(
      entry,
      catalogCell,
      getHostLocale(),
    ).label;
    const id = toastStore.show({
      message: options.message,
      variant: options.variant,
      duration: options.duration,
      key,
      scope,
      pluginLabel,
      ...(options.action === undefined
        ? {}
        : {
          action: {
            label: options.action.label,
            onAction: (): void | Promise<void> => {
              try {
                const result = options.action?.onAction();

                if (result === undefined) {
                  return;
                }

                return Promise.resolve(result).catch((error: unknown): void => {
                  console.error(`[mndw] Toast action failed for plugin "${pluginName}" (${pluginLabel}):`, error);
                });
              } catch (error) {
                console.error(`[mndw] Toast action failed for plugin "${pluginName}" (${pluginLabel}):`, error);
              }
            },
          },
        }),
    });

    return {dismiss: (): void => {
      if (isDisposed()) {
        warnDisposed();

        return;
      }

      toastStore.dismiss(id);
    }};
  };
  const shortcut = (
    variant: NonNullable<PluginToastOptions['variant']>,
    message: string,
    options?: Omit<PluginToastOptions, 'message' | 'variant'>,
  ) => show({...options, message, variant});
  const facade: PluginToasts = Object.freeze({
    show,
    success: (message: string, options?: Omit<PluginToastOptions, 'message' | 'variant'>) =>
      shortcut('success', message, options),
    info: (message: string, options?: Omit<PluginToastOptions, 'message' | 'variant'>) =>
      shortcut('info', message, options),
    warning: (message: string, options?: Omit<PluginToastOptions, 'message' | 'variant'>) =>
      shortcut('warning', message, options),
    error: (message: string, options?: Omit<PluginToastOptions, 'message' | 'variant'>) =>
      shortcut('error', message, options),
    dismiss: (key: string): void => {
      if (isDisposed()) {
        warnDisposed();

        return;
      }

      toastStore.dismissKey(keyFor(key), scope);
    },
  });

  return {
    facade,
    dispose: (): void => {
      for (const current of [...toastStore.toasts]) {
        if (current.scope === scope && current.action !== undefined) {
          toastStore.dismiss(current.id);
        }
      }
    },
  };
}

/** Constructs a backend client from the list descriptor, using a rejecting stub when no routes exist. */
function backendClientFor(entry: PluginListEntry): BackendClient {
  const {routes} = entry.backend;

  if (Object.keys(routes ?? {}).length === 0) {
    return createBackendClient(entry.name, undefined);
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
  const subscribeHostLocaleValue = (callback: (locale: string) => void): () => void =>
    services.locale.subscribeLocale(callback);
  const getPaletteTokens = (): PluginContext['appearance']['palette'] => services.palette.getTokens();
  const eventStream = services.eventStream;

  if (entry.type === 'page' && pageRoute === undefined) {
    throw new Error(`Page plugin "${entry.name}" requires a page route`);
  }

  const lifetime = createPluginLifetime();
  const abortController = new AbortController();
  const theme$ = hostValue$(
    () => services.theme.getTheme(),
    (listener) => services.theme.subscribeTheme(listener),
    lifetime,
  );
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
  const appearance = Object.create(null) as PluginContext['appearance'];

  Object.defineProperties(appearance, {
    theme: {enumerable: true, get: () => services.theme.getTheme()},
    theme$: {enumerable: true, value: theme$},
    palette: {enumerable: true, get: () => getPaletteTokens()},
    palette$: {enumerable: true, value: palette$},
  });
  Object.freeze(appearance);

  const {service, dispose: disposeOverlay} = createPluginOverlayService(
    entry.name,
    instanceId,
    services.overlayRuntime,
  );
  const eventFacadeId = createEventFacadeId();
  const events = eventStream.createFacade(eventFacadeId, entry.name, entry.capabilities ?? [], lifetime);
  let disposed = false;
  const pluginToasts = createPluginToastFacade(
    entry,
    instanceId,
    catalogCell,
    getHostLocale,
    () => disposed,
  );
  const navigation = createPluginNavigation({getRouter: () => services.navigation(), isDisposed: () => disposed});
  const dispose: OverlayDispose = (reason) => {
    if (disposed) {
      return;
    }

    disposed = true;
    abortController.abort();
    lifetime.end();

    eventStream.disposeFacade(eventFacadeId);

    pluginToasts.dispose();
    disposeOverlay(reason);
  };

  const variant = entry.type === 'page'
    ? (() => {
      if (pageRoute === undefined) {
        throw new Error(`Page plugin "${entry.name}" requires a page route`);
      }

      return {kind: 'page' as const, pageRoute};
    })()
    : {kind: 'widget' as const, setTileTitle: setTileTitle ?? (() => {})};
  const context = {
    signal: abortController.signal,
    navigation,
    telemetry,
    events,
    storage: Object.freeze(Object.assign(
      Object.create(null) as {
        instance: PluginContext['storage']['instance'];
        shared: PluginContext['storage']['shared'];
      },
      {
        instance: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:instance:${instanceId}:`),
        shared: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:shared:`),
      },
    )),
    device: Object.freeze(Object.assign(
      Object.create(null) as {
        info: PluginContext['device']['info'];
        rci: PluginContext['device']['rci'];
      },
      {
        info: createDeviceInfoContext(deviceInfo),
        rci: createPluginRci(createServiceFacade(services.rci.driver, PLUGIN_RCI_MANAGER_METHODS)),
      },
    )),
    i18n: createPluginI18n(catalogCell, getHostLocale, subscribeHostLocaleValue, lifetime),
    instanceId,
    timers: createPluginTimers(abortController.signal, () => services.tickerPool.create(lifetime)),
    backend: backendClientFor(entry),
    overlay: service,
    toast: pluginToasts.facade,
    ...variant,
    appearance,
  } satisfies PluginContext;

  Object.setPrototypeOf(context, null);

  return {context: Object.freeze(context), dispose};
}
