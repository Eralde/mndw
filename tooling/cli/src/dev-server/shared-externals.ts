import {pluginDependencies, sharedImportMap} from '@mndw/sdk-internal/shared-dependencies';
import type {Plugin, ResolvedConfig, ViteDevServer} from 'vite';

import type {PluginFramework} from '../framework.js';

/**
 * Rewrites host-provided bare imports to absolute URLs for Vite import analysis. prebuiltHost serves them with loopback
 * CORS because localhost and 127.0.0.1 are distinct origins.
 */
export function sharedExternals(framework: PluginFramework): Plugin {
  const urls = sharedImportMap();
  let config: ResolvedConfig | undefined;
  let server: ViteDevServer | undefined;
  const externals = new Set(pluginDependencies(framework));

  return {
    name: 'mndw-dev-shared-externals',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(viteServer) {
      server = viteServer;
    },
    resolveId(source) {
      if (!externals.has(source)) {
        return undefined;
      }

      const target = urls[source];

      if (target === undefined) {
        return undefined;
      }

      const configuredOrigin = config?.server.origin;
      const resolvedUrl = server?.resolvedUrls?.local[0];
      const origin = configuredOrigin || resolvedUrl || 'http://localhost:5173';

      return {id: new URL(target, origin).href, external: true};
    },
  };
}
