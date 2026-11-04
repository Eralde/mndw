import fs from 'node:fs';
import path from 'node:path';
import {defineConfig, loadEnv} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import vue from '@vitejs/plugin-vue';
import {sharedImportMap, sharedSpecifiers} from '@mndw/sdk-internal/shared-dependencies';
import {devProxies} from '@mndw/sdk-internal/dev-proxies';
import {angularSandboxPlugin, isAngularPlugin} from '@mndw/angular-compiler/vite';
import {reloadOnSentinel} from './scripts/reload-on-sentinel.js';
import {resolveSandboxPluginPath, sandboxPlugin} from './scripts/sandbox-plugin.js';
import {createPluginServeMiddleware} from './scripts/serve-plugins.js';

// Two proxy targets in dev, mirroring the production lighttpd split:
//  - the router device serves the RCI API + auth (`/rci`, `/auth`);
//  - the local mndwd serves plugin dispatch, the ws proxy, and management (`/api`, `/ws`).
export default defineConfig(({mode}) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const env = loadEnv(mode, repoRoot, 'MNDW_');

  const deviceHost = process.env.MNDW_HOST_DEVICE || env.MNDW_HOST_DEVICE || 'http://192.168.1.1';
  const daemonHost = process.env.MNDW_DAEMON || env.MNDW_DAEMON || 'http://127.0.0.1:9090';

  const builtinPluginsDir = process.env.MNDW_BUILTIN_PLUGINS_DIR
    || path.resolve(repoRoot, 'plugins/builtin', 'dist');
  const userPluginsDir = process.env.MNDW_USER_PLUGINS_DIR
    || path.resolve(repoRoot, '.dev-data', 'user-plugins');
  const reloadSentinelPath = process.env.MNDW_DEV_RELOAD_SENTINEL || env.MNDW_DEV_RELOAD_SENTINEL;

  // Single-plugin source-HMR mode (`mndw dev`): resolved only from an explicit env var, so
  // normal startup keeps loading plugins from the daemon list. null -> sandbox off.
  const sandboxPluginPath = resolveSandboxPluginPath(
    process.env.MNDW_SANDBOX_PLUGIN || env.MNDW_SANDBOX_PLUGIN,
    repoRoot,
  );
  const angularSandbox = sandboxPluginPath !== null && isAngularPlugin(sandboxPluginPath)
    ? angularSandboxPlugin(sandboxPluginPath)
    : null;

  const proxy = devProxies({deviceUrl: deviceHost, daemonUrl: daemonHost});
  const sandboxMode = mode === 'dev-host' ? 'url' : sandboxPluginPath === null ? false : 'virtual';

  return {
    plugins: [
      // Always registered so the virtual:sandbox-* ids resolve in every build; serves inert
      // stubs when sandbox mode is off (sandboxPluginPath === null).
      sandboxPlugin(sandboxPluginPath),
      ...(angularSandbox === null ? [] : [angularSandbox]),
      svelte(),
      vue(),
      ...(reloadSentinelPath === undefined ? [] : [reloadOnSentinel(reloadSentinelPath)]),
      {
        // Serve the versioned shared-dependency bundles from dist/shared in dev.
        name: 'mndw-serve-shared',
        configureServer(server) {
          const sharedDir = path.resolve(__dirname, 'dist', 'shared');

          server.middlewares.use('/shared', (req, res, next) => {
            const filePath = path.join(sharedDir, req.url!);

            try {
              const content = fs.readFileSync(filePath);
              res.setHeader('Content-Type', 'application/javascript');
              res.end(content);
            } catch {
              next();
            }
          });
        },
      },
      {
        // Serve plugin bundles in dev so the loader's import() resolves real assets:
        //   /plugins/<name>/*      -> built builtin plugins (plugins/builtin/dist)
        //   /user-plugins/<name>/* -> approved user plugins
        // Mirrors mndw-serve-shared; prod serving is lighttpd's job.
        name: 'mndw-serve-plugins',
        configureServer(server) {
          const dirs = {builtinDir: builtinPluginsDir, userDir: userPluginsDir};
          server.middlewares.use(createPluginServeMiddleware(dirs));
        },
      },
      {
        // Inject the shared-dependency import map so plugins resolve host-provided
        // deps to `/shared/<bundle>@<version>.js` at runtime.
        name: 'mndw-import-map',
        transformIndexHtml(html) {
          const importMap = JSON.stringify({imports: sharedImportMap()}, null, 2);

          return html.replace(
            '</head>',
            `<script type="importmap">\n${importMap}\n</script>\n</head>`,
          );
        },
      },
    ],
    server: {
      cors: false,
      // Keep host source files allowed when the sandbox plugin adds its external source dir.
      // Vite merges array-valued fs.allow entries, so both workspace and plugin remain served.
      fs: {
        allow: [repoRoot],
      },
      proxy,
    },
    // Compile-time flag selects repo virtual modules, prebuilt-host URLs, or normal loading.
    define: {
      __MNDW_SANDBOX__: JSON.stringify(sandboxMode),
      __MNDW_PSEUDO_LOCALE_ENABLED__: JSON.stringify(mode === 'development'),
    },
    build: {
      rollupOptions: {
        external: sharedSpecifiers(),
        output: {
          paths: sharedImportMap(),
        },
      },
    },
  };
});
