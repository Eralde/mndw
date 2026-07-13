import {type SandboxImports, reloadSandboxPlugin} from './sandbox-loader.js';

/**
 * The one place the `virtual:sandbox-*` specifiers appear as literals so Vite's sandbox
 * plugin can resolve them in the real dev server. Imported only by the application (never a
 * test), because vitest has no sandbox plugin and would fail to resolve the virtual modules —
 * tests inject their own imports and mock this module.
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
 * literals that vitest cannot resolve.
 */
export function setupSandboxHmr(): void {
  if (!import.meta.hot) {
    return;
  }

  const accept = (): void => {
    void reloadSandboxPlugin(sandboxVirtualImports);
  };

  import.meta.hot.accept('virtual:sandbox-plugin', accept);
  import.meta.hot.accept('virtual:sandbox-manifest', accept);
}
