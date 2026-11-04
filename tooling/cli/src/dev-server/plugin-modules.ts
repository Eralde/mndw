import {resolve} from 'node:path';

import {renderSandboxManifest, renderSandboxModule} from '@mndw/sdk-internal/dev-sandbox';
import type {EnvironmentModuleNode, Plugin, ViteDevServer} from 'vite';

const PLUGIN_URL = '/@mndw-dev/plugin.js';
const MANIFEST_URL = '/@mndw-dev/manifest.js';
const PLUGIN_ID = '\0mndw-dev:plugin';
const MANIFEST_ID = '\0mndw-dev:manifest';

function moduleWrapper(source: string, event: string): string {
  return `${source}\nif (import.meta.hot) import.meta.hot.accept((m) => window.dispatchEvent(new CustomEvent(${
    JSON.stringify(event)
  }, {detail: m})));`;
}

/** Serves HMR-aware source and manifest modules for the URL sandbox runtime. */
export function pluginModules(pluginDir: string): Plugin {
  const root = resolve(pluginDir);
  const manifestPath = resolve(root, 'manifest.json');
  let server: ViteDevServer | undefined;

  const getModule = (id: string): EnvironmentModuleNode | undefined => {
    return server?.environments.client.moduleGraph.getModuleById(id);
  };

  return {
    name: 'mndw-dev-plugin-modules',
    resolveId(source) {
      if (source === PLUGIN_URL) {
        return PLUGIN_ID;
      }

      if (source === MANIFEST_URL) {
        return MANIFEST_ID;
      }

      return undefined;
    },
    load(id) {
      if (id === PLUGIN_ID) {
        return moduleWrapper(renderSandboxModule(root), 'mndw:dev-plugin-update');
      }

      if (id === MANIFEST_ID) {
        const rendered = renderSandboxManifest(root).replace(
          /export const __catalogBaseUrl = [^;]+;/,
          'export const __catalogBaseUrl = "/";',
        );

        return moduleWrapper(rendered, 'mndw:dev-manifest-update');
      }

      return undefined;
    },
    configureServer(viteServer) {
      server = viteServer;
      viteServer.watcher.add(manifestPath);
    },
    hotUpdate(context) {
      const file = resolve(context.file);

      if (file === manifestPath) {
        const manifestModule = getModule(MANIFEST_ID);

        if (manifestModule === undefined) {
          return undefined;
        }

        server?.environments.client.moduleGraph.invalidateModule(manifestModule);

        return [manifestModule];
      }

      const sourceRoot = resolve(root, 'src');
      const relativePath = file.slice(sourceRoot.length);
      const isSourceFile = file.startsWith(`${sourceRoot}/`) || file.startsWith(`${sourceRoot}\\`);
      const isFrameworkComponent = isSourceFile
        && ['.vue', '.svelte'].includes(relativePath.slice(relativePath.lastIndexOf('.')));

      if (!isFrameworkComponent) {
        return undefined;
      }

      const wrapper = getModule(PLUGIN_ID);

      if (wrapper === undefined) {
        return undefined;
      }

      const updated = [...new Set([...context.modules, wrapper])];

      for (const module of updated) {
        server?.environments.client.moduleGraph.invalidateModule(module);
      }

      return updated;
    },
  };
}
