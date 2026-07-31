import type {HostInfo, PluginContext} from '@mndw/sdk';
import {FALLBACK_HOST_INFO} from '../constants.js';
import {createPluginContext} from '../runtime/plugin-context.js';
import {pluginRegistry} from '../runtime/plugin-registry.js';
import {appState} from '../state/app.svelte.js';

/**
 * Builds a plugin context for a dashboard widget instance. Resolves host info from the
 * explicit argument, then the fetched {@link appState.hostInfo}, then the host fallback,
 * then delegates to the Phase 4a {@link createPluginContext} using the plugin's canonical
 * list `entry` (the daemon is authoritative for the backend descriptor).
 */
export function createWidgetContext(
  pluginName: string,
  instanceId: string,
  hostInfo?: HostInfo,
  setTileTitle?: (title: string) => void,
): PluginContext {
  const effectiveHostInfo = hostInfo ?? appState.hostInfo ?? FALLBACK_HOST_INFO;
  const plugin = pluginRegistry.get(pluginName);

  if (!plugin) {
    throw new Error(`No loaded plugin "${pluginName}"`);
  }

  return createPluginContext(plugin.entry, instanceId, effectiveHostInfo, setTileTitle);
}
