import {
  type MountedPlugin,
  type OverlayTeardownReason,
  mountPlugin,
  unmountPlugin,
} from '../runtime/plugin-lifecycle.js';
import type {PluginContextHandle} from '../runtime/plugin-context.js';
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
  /**
   * Resolves once the mount has settled: `true` when `createInstance` succeeded, `false`
   * when it failed (synchronously or asynchronously). Lets a hot-reload transaction await
   * every affected tile before committing or rolling back.
   */
  whenReady(): Promise<boolean>;
}

export function mountWidgetTile(
  container: HTMLElement,
  plugin: LoadedPlugin,
  handle: PluginContextHandle,
): WidgetTileHandle {
  let mounted: MountedPlugin | null = null;
  let disposed = false;
  let disposeOptions: WidgetTileDisposeOptions | undefined;

  const result = mountPlugin(container, plugin, handle.context, handle.dispose, {errorText: 'Error loading widget'});

  let ready: Promise<boolean>;

  if (result instanceof Promise) {
    ready = result.then((resolved) => {
      mounted = resolved;

      // Tile was torn down before the async mount resolved: unmount immediately with the
      // options recorded at dispose time.
      if (disposed) {
        unmountPlugin(mounted, container, disposeOptions);
        mounted = null;
      }

      return resolved !== null;
    });
  } else {
    mounted = result;
    ready = Promise.resolve(result !== null);
  }

  return {
    getMounted: () => mounted,
    whenReady: () => ready,
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
