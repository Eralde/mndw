import {type SandboxImports, reloadSandboxPlugin} from './sandbox-loader.js';
import type {HostServices} from '../host-services.js';

/**
 * The one place the `virtual:sandbox-*` specifiers appear as literals so Vite's sandbox
 * plugin can resolve them in the real dev server. The application uses these defaults; tests
 * inject their own HMR context and import providers, with Vitest stand-ins for these modules.
 */
export const sandboxVirtualImports: SandboxImports = {
  importPluginModule: () => import('virtual:sandbox-plugin'),
  importManifestModule: () => import('virtual:sandbox-manifest'),
};

/**
 * Wires Vite HMR: any change to the sandbox plugin's source or manifest invalidates both
 * virtual modules (see the `mndw-sandbox` Vite plugin), which re-runs this accept handler as
 * one reload transaction driven by {@link reloadSandboxPlugin}. No-op outside a Vite dev
 * server. Lives here (not in `sandbox-loader.ts`) so the loader stays free of `virtual:`
 * literals that Vitest cannot resolve without its test-only virtual-module setup.
 */
interface PendingModule {
  received: boolean;
  value: unknown;
}

function pendingModule(): PendingModule {
  return {received: false, value: undefined};
}

export function setupSandboxHmr(
  services: HostServices,
  hot: NonNullable<ImportMeta['hot']> | undefined = import.meta.hot,
  imports: SandboxImports = sandboxVirtualImports,
): void {
  if (hot === undefined) {
    return;
  }

  let pendingPlugin = pendingModule();
  let pendingManifest = pendingModule();
  let reloadScheduled = false;
  let reloadChain: Promise<void> = Promise.resolve();

  const scheduleReload = (): void => {
    if (reloadScheduled) {
      return;
    }

    reloadScheduled = true;
    queueMicrotask(() => {
      reloadScheduled = false;

      const pluginUpdate = pendingPlugin;
      const manifestUpdate = pendingManifest;

      pendingPlugin = pendingModule();
      pendingManifest = pendingModule();

      const reloadImports: SandboxImports = {
        importPluginModule: pluginUpdate.received
          ? () => Promise.resolve(pluginUpdate.value)
          : imports.importPluginModule,
        importManifestModule: manifestUpdate.received
          ? () => Promise.resolve(manifestUpdate.value as {default?: unknown})
          : imports.importManifestModule,
      };

      reloadChain = reloadChain
        .then(() =>
          reloadSandboxPlugin({
            ...reloadImports,
            registry: services.registry,
            catalogService: services.catalog,
            getLocale: () => services.locale.getLocale(),
            pluginContextServices: {
              locale: services.locale,
              palette: services.palette,
              telemetry: services.telemetry,
              eventStream: services.eventStream,
            },
          })
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('[mndw] Sandbox HMR transaction failed:', error);
        });
    });
  };

  hot.accept('virtual:sandbox-plugin', (module) => {
    pendingPlugin = {received: true, value: module};
    scheduleReload();
  });
  hot.accept('virtual:sandbox-manifest', (module) => {
    pendingManifest = {received: true, value: module};
    scheduleReload();
  });
}
