import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {clearInstanceStorage} from '../services/storage.service.js';
import type {OverlayDispose, PluginContextHandle} from './plugin-context.js';
import type {LoadedPlugin} from './plugin-registry.js';

export type OverlayTeardownReason = 'plugin-unmount' | 'host-navigation';

export interface MountedPlugin {
  pluginName: string;
  instanceId: string;
  instance: PluginInstance;
  /**
   * Disposes this instance's context, including its overlays. Runs before
   * `instance.unmount()` so overlay `closed` reasons reflect teardown cause.
   * Optional so test fixtures may omit it.
   */
  disposeOverlayService?: (reason?: OverlayTeardownReason) => void;
}

export interface PluginMountOptions {
  errorText?: string;
}

export interface PluginUnmountOptions {
  clearStorage?: boolean;
  /** Teardown cause propagated to plugin-owned overlays. Defaults to 'plugin-unmount'. */
  closeReason?: OverlayTeardownReason;
}

export interface PluginMountHandle {
  getMounted(): MountedPlugin | null;
  dispose(options?: PluginUnmountOptions): void;
  /** Resolves once createInstance settles; true on success, false on failure. */
  whenReady(): Promise<boolean>;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return typeof (value as {then?: unknown}).then === 'function';
}

export function mountPlugin(
  container: HTMLElement,
  plugin: LoadedPlugin,
  context: PluginContext,
  disposeOverlayService: OverlayDispose,
  options?: PluginMountOptions,
): Promise<MountedPlugin | null> | MountedPlugin | null {
  const name = plugin.entry.name;

  try {
    const result = plugin.module.createInstance(container, context);

    if (isPromiseLike(result)) {
      return Promise.resolve(result)
        .then((instance) => ({
          pluginName: name,
          instanceId: context.instanceId,
          instance,
          disposeOverlayService,
        }))
        .catch((err: unknown) => {
          console.error(`[mndw] Plugin "${name}" createInstance failed:`, err);

          // Nothing mounted, but the overlay service was created with the context.
          disposeOverlayService('plugin-unmount');

          if (options?.errorText) {
            container.textContent = options.errorText;
          }

          return null;
        });
    }

    return {
      pluginName: name,
      instanceId: context.instanceId,
      instance: result,
      disposeOverlayService,
    };
  } catch (err) {
    console.error(`[mndw] Plugin "${name}" createInstance failed:`, err);

    disposeOverlayService('plugin-unmount');

    if (options?.errorText) {
      container.textContent = options.errorText;
    }

    return null;
  }
}

function cleanupMountedPlugin(
  mounted: MountedPlugin,
  container: HTMLElement,
  options: PluginUnmountOptions | undefined,
  disposeContext: boolean,
): void {
  // Dispose context before instance teardown so overlays receive host cause
  // (plugin-unmount / host-navigation), not stale 'api'.
  if (disposeContext) {
    try {
      mounted.disposeOverlayService?.(options?.closeReason ?? 'plugin-unmount');
    } catch (err) {
      console.error(`[mndw] Plugin "${mounted.pluginName}" overlay teardown failed:`, err);
    }
  }

  try {
    // Teardown remains synchronous from the host's perspective, but rejected async
    // unmounts still need to be observed to avoid an unhandled rejection.
    void mounted.instance.unmount()?.catch((err: unknown) => {
      console.error(`[mndw] Plugin "${mounted.pluginName}" unmount failed:`, err);
    });
  } catch (err) {
    console.error(`[mndw] Plugin "${mounted.pluginName}" unmount failed:`, err);
  }

  if (options?.clearStorage !== false) {
    clearInstanceStorage(mounted.pluginName, mounted.instanceId);
  }

  container.innerHTML = '';
}

export function unmountPlugin(
  mounted: MountedPlugin | null,
  container: HTMLElement,
  options?: PluginUnmountOptions,
): void {
  if (mounted === null) {
    container.innerHTML = '';

    return;
  }

  cleanupMountedPlugin(mounted, container, options, true);
}

/** Mounts a plugin and owns context disposal across both pending and completed mounts. */
export function mountPluginWithContext(
  container: HTMLElement,
  plugin: LoadedPlugin,
  contextHandle: PluginContextHandle,
  options?: PluginMountOptions,
): PluginMountHandle {
  let mounted: MountedPlugin | null = null;
  let mountSettled = false;
  let disposed = false;
  let disposeOptions: PluginUnmountOptions | undefined;
  let contextDisposed = false;

  const disposeContext: OverlayDispose = (reason) => {
    if (contextDisposed) {
      return;
    }

    contextDisposed = true;
    contextHandle.dispose(reason);
  };

  const result = mountPlugin(container, plugin, contextHandle.context, disposeContext, options);
  let ready: Promise<boolean>;

  if (result instanceof Promise) {
    ready = result.then((resolved) => {
      mountSettled = true;
      mounted = resolved;

      if (disposed) {
        if (resolved !== null) {
          cleanupMountedPlugin(resolved, container, disposeOptions, false);
        } else {
          if (disposeOptions?.clearStorage === true) {
            clearInstanceStorage(plugin.entry.name, contextHandle.context.instanceId);
          }

          container.innerHTML = '';
        }

        mounted = null;
      }

      return resolved !== null;
    });
  } else {
    mountSettled = true;
    mounted = result;
    ready = Promise.resolve(result !== null);
  }

  return {
    getMounted: () => mounted,
    whenReady: () => ready,
    dispose(unmountOptions) {
      if (disposed) {
        return;
      }

      disposed = true;
      disposeOptions = unmountOptions;

      if (mounted !== null) {
        cleanupMountedPlugin(mounted, container, unmountOptions, true);
        mounted = null;

        return;
      }

      if (!mountSettled) {
        try {
          disposeContext(unmountOptions?.closeReason ?? 'plugin-unmount');
        } catch (err) {
          console.error(`[mndw] Plugin "${plugin.entry.name}" context teardown failed:`, err);
        }

        container.innerHTML = '';

        return;
      }

      if (unmountOptions?.clearStorage === true) {
        clearInstanceStorage(plugin.entry.name, contextHandle.context.instanceId);
      }
    },
  };
}
