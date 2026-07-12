import type {PluginContext} from '@mndw/sdk';
import {
  type MountedPlugin,
  type OverlayTeardownReason,
  mountPlugin,
  unmountPlugin,
} from '../runtime/plugin-lifecycle.js';
import type {LoadedPlugin} from '../runtime/plugin-registry.js';

export interface WidgetTileDisposeOptions {
  clearStorage?: boolean;
  closeReason?: OverlayTeardownReason;
}

/**
 * Tracks a mounted widget tile — including plugins whose `createInstance` resolves
 * asynchronously — so teardown always routes through {@link unmountPlugin}. Without
 * this, an async mount that resolves after the tile is removed would leak its instance
 * and overlays.
 */
export interface WidgetTileHandle {
  getMounted(): MountedPlugin | null;
  dispose(options?: WidgetTileDisposeOptions): void;
}

export function mountWidgetTile(
  container: HTMLElement,
  plugin: LoadedPlugin,
  context: PluginContext,
): WidgetTileHandle {
  let mounted: MountedPlugin | null = null;
  let disposed = false;
  let disposeOptions: WidgetTileDisposeOptions | undefined;

  const result = mountPlugin(container, plugin, context, {errorText: 'Error loading widget'});

  if (result instanceof Promise) {
    void result.then((resolved) => {
      mounted = resolved;

      // Tile was torn down before the async mount resolved: unmount immediately with the
      // options recorded at dispose time.
      if (disposed) {
        unmountPlugin(mounted, container, disposeOptions);
        mounted = null;
      }
    });
  } else {
    mounted = result;
  }

  return {
    getMounted: () => mounted,
    dispose(options) {
      if (disposed) {
        return;
      }

      disposed = true;
      disposeOptions = options;

      if (mounted) {
        unmountPlugin(mounted, container, options);
        mounted = null;
      }
    },
  };
}
