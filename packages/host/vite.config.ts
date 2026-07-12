import type {ClientRequest} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {sharedImportMap, sharedSpecifiers} from '@mndw/sdk/shared-dependencies';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {resolvePluginRequest} from './scripts/serve-plugins.js';
import type {ProxyOptions} from 'vite';
import {defineConfig, loadEnv} from 'vite';

// Two proxy targets in dev, mirroring the production lighttpd split (design §2):
//  - the router device serves the RCI API + auth (`/rci`, `/auth`);
//  - the local mndwd serves plugin dispatch, the ws proxy, and management (`/api`, `/ws`).
export default defineConfig(({mode}) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const env = loadEnv(mode, repoRoot, 'MNDW_');

  const deviceHost = process.env.MNDW_HOST_DEVICE || env.MNDW_HOST_DEVICE || 'http://192.168.1.1';
  const daemonHost = process.env.MNDW_DAEMON || env.MNDW_DAEMON || 'http://127.0.0.1:9090';
  const deviceUrl = new URL(deviceHost);

  const builtinPluginsDir = process.env.MNDW_BUILTIN_PLUGINS_DIR
    || path.resolve(repoRoot, 'example-plugins', 'dist');
  const userPluginsDir = process.env.MNDW_USER_PLUGINS_DIR
    || path.resolve(repoRoot, '.dev-data', 'user-plugins');

  function deviceProxy(apiPath: string, ws = false): ProxyOptions {
    return {
      target: deviceHost,
      changeOrigin: true,
      ws,
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq: ClientRequest) => {
          proxyReq.setHeader('Host', deviceUrl.host);
          proxyReq.setHeader('Origin', deviceUrl.origin);
        });
        proxy.on('error', (err) => {
          console.error(`[vite proxy] [${apiPath}] error:`, err.message);
        });
      },
    };
  }

  function daemonProxy(ws = false): ProxyOptions {
    return {target: daemonHost, changeOrigin: true, ws};
  }

  return {
    plugins: [
      svelte(),
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
        //   /plugins/<name>/*      → built builtin plugins (example-plugins/dist)
        //   /user-plugins/<name>/* → approved user plugins (empty until Phase 6)
        // Mirrors mndw-serve-shared; prod serving is lighttpd's job (Phase 8).
        name: 'mndw-serve-plugins',
        configureServer(server) {
          const dirs = {builtinDir: builtinPluginsDir, userDir: userPluginsDir};

          server.middlewares.use((req, res, next) => {
            const resolved = req.url ? resolvePluginRequest(req.url, dirs) : null;

            if (!resolved) {
              next();

              return;
            }

            fs.readFile(resolved.filePath, (err, content) => {
              if (err) {
                next();

                return;
              }

              res.setHeader('Content-Type', resolved.contentType);
              res.end(content);
            });
          });
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
      proxy: {
        '/rci': deviceProxy('/rci'),
        '/auth': deviceProxy('/auth'),
        '/api': daemonProxy(),
        '/ws': daemonProxy(true),
      },
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
