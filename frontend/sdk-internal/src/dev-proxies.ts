import type {ClientRequest} from 'node:http';
import type {ProxyOptions} from 'vite';

export interface DevProxyOptions {
  deviceUrl: string;
  daemonUrl: string;
}

export function devProxies(options: DevProxyOptions): Record<string, ProxyOptions> {
  const deviceUrl = new URL(options.deviceUrl);

  function deviceProxy(apiPath: string): ProxyOptions {
    return {
      target: options.deviceUrl,
      changeOrigin: true,
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
    // Preserve browser-origin headers for CSRF and WebSocket origin policy.
    return {target: options.daemonUrl, changeOrigin: false, ws};
  }

  return {
    '/rci': deviceProxy('/rci'),
    '/auth': deviceProxy('/auth'),
    '/api': daemonProxy(),
    '/ws': daemonProxy(true),
  };
}
