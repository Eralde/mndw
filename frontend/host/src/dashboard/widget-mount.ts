import {
  type PluginMountHandle,
  type PluginMountOptions,
  type PluginUnmountOptions,
  mountPluginWithContext,
} from '../runtime/plugin-lifecycle.js';
import type {PluginContextHandle} from '../runtime/plugin-context.js';
import type {LoadedPlugin} from '../runtime/plugin-registry.js';

export type WidgetTileDisposeOptions = PluginUnmountOptions;

/** Tracks a widget mount so context disposal and late instance teardown share one owner. */
export type WidgetTileHandle = PluginMountHandle;

export function mountWidgetTile(
  container: HTMLElement,
  plugin: LoadedPlugin,
  handle: PluginContextHandle,
  options?: PluginMountOptions,
): WidgetTileHandle {
  return mountPluginWithContext(container, plugin, handle, options);
}
