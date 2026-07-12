import {
  type BackendClient,
  type BackendDescriptor,
  type HostInfo,
  type PluginContext,
  createBackendClient,
} from '@mndw/sdk';
import {PLUGIN_STORAGE_PREFIX} from '../constants.js';
import {injector} from '../services/injector.service.js';
import {createPluginOverlayService} from '../services/overlay/overlay-manager.svelte.js';
import {rciService} from '../services/rci.service.js';
import {ScopedPluginStorage} from '../services/storage.service.js';
import {getTheme, subscribeTheme} from '../services/theme.service.js';
import type {PluginListEntry} from './plugin-types.js';

type OverlayDispose = (reason?: 'plugin-unmount' | 'host-navigation') => void;

// Holds each instance's host-internal overlay teardown until the lifecycle layer
// claims it (see consumeOverlayDispose). Plugins only ever see the public service.
const pendingOverlayDisposers = new Map<string, OverlayDispose>();

/**
 * Constructs the backend client from the list descriptor, or returns undefined when
 * the plugin declares nothing callable (no endpoints, no websockets) — a daemon-only
 * or backendless plugin gets no `context.backend`.
 */
function backendClientFor(entry: PluginListEntry): BackendClient | undefined {
  const {endpoints, websockets, public: isPublic} = entry.backend;

  if (Object.keys(endpoints).length === 0 && Object.keys(websockets).length === 0) {
    return undefined;
  }

  const descriptor: BackendDescriptor = {
    endpoints,
    websockets,
    approval: entry.approval,
    enabled: entry.enabled,
    public: isPublic,
  };

  return createBackendClient(entry.name, descriptor);
}

/**
 * Builds the {@link PluginContext} handed to a plugin's `createInstance`. The typed
 * backend client is derived from the daemon list entry's descriptor (design §3.3),
 * replacing v1's `backend-bindings.service` — the daemon is now authoritative for
 * approval/enabled, and the client maps its error envelope to typed errors.
 */
export function createPluginContext(
  entry: PluginListEntry,
  instanceId: string,
  hostInfo: HostInfo,
): PluginContext {
  const {service, dispose} = createPluginOverlayService(entry.name, instanceId);

  pendingOverlayDisposers.set(instanceId, dispose);

  return {
    rciManager: rciService.driver,
    sessionManager: rciService.auth,
    storage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:instance:${instanceId}:`),
    sharedStorage: new ScopedPluginStorage(`${PLUGIN_STORAGE_PREFIX}:${entry.name}:shared:`),
    hostInfo: {...hostInfo, theme: getTheme()},
    injector,
    instanceId,
    backend: backendClientFor(entry),
    onThemeChange: subscribeTheme,
    overlay: service,
  };
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
