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
import {createPluginI18n} from '../services/plugin-catalog.service.js';
import {injector} from '../services/injector.service.js';
import {createPluginOverlayService} from '../services/overlay/overlay-manager.svelte.js';
import {rciService} from '../services/rci.service.js';
import {ScopedPluginStorage} from '../services/storage.service.js';
import {getTokens, subscribePalette} from '../services/palette.service.js';
import {getTheme, subscribeTheme} from '../services/theme.service.js';
import type {PluginListEntry} from './plugin-types.js';
import {createReadonlyInjector, createServiceFacade} from './service-facade.js';

type OverlayDispose = (reason?: 'plugin-unmount' | 'host-navigation') => void;

// Holds each instance's host-internal overlay teardown until the lifecycle layer
// claims it (see consumeOverlayDispose). Plugins only ever see the public service.
const pendingOverlayDisposers = new Map<string, OverlayDispose>();

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
 * the plugin declares nothing callable (no routes) - a backendless
 * or backendless plugin gets no `context.backend`.
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
export function createPluginContext(
  entry: PluginListEntry,
  instanceId: string,
  hostInfo: HostInfo,
  setTileTitle?: (title: string) => void,
  pageRoute?: PageRoute,
  catalogCell?: import('../services/plugin-catalog.service.js').PluginCatalogCell,
): PluginContext {
  const {service, dispose} = createPluginOverlayService(entry.name, instanceId);

  pendingOverlayDisposers.set(instanceId, dispose);

  const context: PluginContext = Object.assign(
    Object.create(null),
    {
      // SDK exposes concrete classes with private fields; runtime facades intentionally contain only
      // public methods, so cast narrowed facades at this plugin-context boundary.
      rciManager: createServiceFacade(rciService.driver, RCI_MANAGER_METHODS) as unknown as PluginContext['rciManager'],
      storage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:instance:${instanceId}:`),
      sharedStorage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:shared:`),
      hostInfo: Object.freeze(
        Object.assign(Object.create(null), {...hostInfo, locale: getLocale(), theme: getTheme()}),
      ),
      i18n: createPluginI18n(catalogCell, getLocale, (callback) => subscribeLocale(() => callback())),
      injector: createReadonlyInjector(injector),
      instanceId,
      backend: backendClientFor(entry),
      onThemeChange: subscribeTheme,
      getTokens,
      onPaletteChange: subscribePalette,
      overlay: service,
      setTileTitle,
      pageRoute: entry.type === 'page' ? pageRoute : undefined,
    } satisfies PluginContext,
  );

  return Object.freeze(context);
}

/**
 * Claims the overlay teardown hook for a freshly created context so the plugin
 * lifecycle can run it on unmount. Returns a no-op if none is pending.
 */
export function consumeOverlayDispose(instanceId: string): OverlayDispose {
  const dispose = pendingOverlayDisposers.get(instanceId);

  pendingOverlayDisposers.delete(instanceId);

  return dispose ?? (() => {});
}
