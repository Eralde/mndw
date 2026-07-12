import type {ClientRequest} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {sharedImportMap, sharedSpecifiers} from '@mndw/sdk/shared-dependencies';
import {svelte} from '@sveltejs/vite-plugin-svelte';
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
