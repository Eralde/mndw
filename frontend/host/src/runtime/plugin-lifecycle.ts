import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {clearInstanceStorage} from '../services/storage.service.js';
import {consumeOverlayDispose} from './plugin-context.js';
import type {LoadedPlugin} from './plugin-registry.js';

export type OverlayTeardownReason = 'plugin-unmount' | 'host-navigation';

export interface MountedPlugin {
  pluginName: string;
  instanceId: string;
  instance: PluginInstance;
  /**
   * Closes any overlays this instance opened. Runs before `instance.unmount()` so
   * overlay `closed` reasons reflect the teardown cause. Optional so test fixtures
   * may omit it.
   */
  disposeOverlayService?: (reason?: OverlayTeardownReason) => void;
}

interface MountOptions {
  errorText?: string;
}

interface UnmountOptions {
  clearStorage?: boolean;
  /** Teardown cause propagated to plugin-owned overlays. Defaults to 'plugin-unmount'. */
  closeReason?: OverlayTeardownReason;
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
  options?: MountOptions,
): Promise<MountedPlugin | null> | MountedPlugin | null {
  const disposeOverlayService = consumeOverlayDispose(context.instanceId);
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

export function unmountPlugin(
  mounted: MountedPlugin | null,
  container: HTMLElement,
  options?: UnmountOptions,
): void {
  if (!mounted) {
    container.innerHTML = '';

    return;
  }

  // Close plugin-owned overlays before the instance tears down so their `closed`
  // reason is the host cause (plugin-unmount / host-navigation), not a stale 'api'.
  try {
    mounted.disposeOverlayService?.(options?.closeReason ?? 'plugin-unmount');
  } catch (err) {
    console.error(`[mndw] Plugin "${mounted.pluginName}" overlay teardown failed:`, err);
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
