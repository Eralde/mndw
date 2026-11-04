import {describe, expect, it, vi} from 'vitest';
import {devProxies} from './dev-proxies.js';

describe('devProxies', () => {
  it('rewrites device request host and origin while preserving daemon browser origin', () => {
    const proxies = devProxies({deviceUrl: 'http://192.168.1.1:8080', daemonUrl: 'http://127.0.0.1:9090'});
    const device = proxies['/rci'];
    const api = proxies['/api'];
    const ws = proxies['/ws'];
    const on = vi.fn();
    const setHeader = vi.fn();

    expect(device?.target).toBe('http://192.168.1.1:8080');
    expect(device?.changeOrigin).toBe(true);
    expect(api?.target).toBe('http://127.0.0.1:9090');
    expect(api?.changeOrigin).toBe(false);
    expect(ws?.ws).toBe(true);
    expect(ws?.changeOrigin).toBe(false);

    device?.configure?.({on} as never, device);

    const proxyRequestHandler = on.mock.calls.find(([event]) => event === 'proxyReq')?.[1] as
      | ((request: {setHeader(name: string, value: string): void}) => void)
      | undefined;

    expect(proxyRequestHandler).toBeTypeOf('function');

    if (typeof proxyRequestHandler === 'function') {
      proxyRequestHandler({setHeader});
    }

    expect(setHeader).toHaveBeenNthCalledWith(1, 'Host', '192.168.1.1:8080');
    expect(setHeader).toHaveBeenNthCalledWith(2, 'Origin', 'http://192.168.1.1:8080');
  });
});
