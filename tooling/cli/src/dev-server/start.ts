import {resolve} from 'node:path';

import {angularSandboxPlugin} from '@mndw/angular-compiler/vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import vue from '@vitejs/plugin-vue';
import {createServer} from 'vite';

import {devProxies} from '@mndw/sdk-internal/dev-proxies';
import {pluginDependencies} from '@mndw/sdk-internal/shared-dependencies';
import type {PluginFramework} from '../framework.js';
import {pluginModules} from './plugin-modules.js';
import {prebuiltHost} from './prebuilt-host.js';
import {sharedExternals} from './shared-externals.js';

export interface PluginDevServerOptions {
  readonly pluginDir: string;
  readonly hostBundleDir: string;
  readonly port: number;
  readonly deviceUrl?: string;
  readonly daemonUrl: string;
  readonly framework: PluginFramework;
}

export interface PluginDevServerHandle {
  readonly url: string;
  reload(): void;
  close(): Promise<void>;
}

/** Starts Vite as a same-origin source server beside the prebuilt URL sandbox host. */
export async function startPluginDevServer(options: PluginDevServerOptions): Promise<PluginDevServerHandle> {
  const frameworkPlugins = options.framework === 'svelte'
    ? [svelte()]
    : options.framework === 'vue'
    ? [vue({isProduction: true})]
    : options.framework === 'angular'
    ? [angularSandboxPlugin(options.pluginDir)]
    : [];
  const server = await createServer({
    root: options.pluginDir,
    cacheDir: resolve(options.pluginDir, 'node_modules', `.vite-${options.framework}-dev`),
    configFile: false,
    appType: 'custom',
    plugins: [
      ...frameworkPlugins,
      sharedExternals(options.framework),
      pluginModules(options.pluginDir),
      prebuiltHost(options.hostBundleDir),
    ],
    optimizeDeps: {exclude: pluginDependencies(options.framework)},
    server: {
      host: '127.0.0.1',
      port: options.port,
      strictPort: true,
      proxy: devProxies({
        deviceUrl: options.deviceUrl ?? 'http://192.168.1.1',
        daemonUrl: options.daemonUrl,
      }),
    },
  });

  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }

  const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${options.port}`;

  return {
    url,
    reload: () => server.ws.send({type: 'full-reload'}),
    close: () => server.close(),
  };
}
