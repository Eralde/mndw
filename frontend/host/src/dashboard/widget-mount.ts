import {
  type PluginMountHandle,
  type PluginUnmountOptions,
  mountPluginWithContext,
} from '../runtime/plugin-lifecycle.js';
import type {PluginContextHandle} from '../runtime/plugin-context.js';
import type {LoadedPlugin} from '../runtime/plugin-registry.js';
import {hostT} from '../services/locale.service.js';

export type WidgetTileDisposeOptions = PluginUnmountOptions;

/** Tracks a widget mount so context disposal and late instance teardown share one owner. */
export interface WidgetTileHandle extends PluginMountHandle {}

export function mountWidgetTile(
  container: HTMLElement,
  plugin: LoadedPlugin,
  handle: PluginContextHandle,
): WidgetTileHandle {
  return mountPluginWithContext(container, plugin, handle, {errorText: hostT('dashboard.widget-error')});
}
