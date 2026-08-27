import {describe, expect, it, vi} from 'vitest';
import {createPluginServeMiddleware, resolvePluginRequest} from './serve-plugins.js';

const dirs = {builtinDir: '/b', userDir: '/u'};

describe('resolvePluginRequest', () => {
  it('maps a builtin plugin JS request (stripping the ?import query vite adds)', () => {
    expect(resolvePluginRequest('/plugins/sample-page/index.js?import', dirs)).toEqual({
      filePath: '/b/sample-page/index.js',
      contentType: 'application/javascript',
    });
  });

  it('maps a user plugin CSS request', () => {
    expect(resolvePluginRequest('/user-plugins/foo/index.css', dirs)).toEqual({
      filePath: '/u/foo/index.css',
      contentType: 'text/css',
    });
  });

  it('serves manifest.json as application/json', () => {
    expect(resolvePluginRequest('/plugins/foo/manifest.json', dirs)?.contentType)
      .toBe('application/json');
  });

  it('returns null for non-plugin URLs', () => {
    expect(resolvePluginRequest('/src/main.ts', dirs)).toBeNull();
    expect(resolvePluginRequest('/shared/rxjs@7.8.2.js', dirs)).toBeNull();
  });

  it('rejects path traversal out of the base dir', () => {
    expect(resolvePluginRequest('/plugins/../../etc/passwd', dirs)).toBeNull();
  });
});

describe('createPluginServeMiddleware', () => {
  it('serves plugin assets with a no-store cache header', async () => {
    const readFile = vi.fn((_filePath: string, callback: (error: null, content: Buffer) => void) => {
      callback(null, Buffer.from('asset'));
    });
    const middleware = createPluginServeMiddleware(dirs, {readFile});
    const response = {
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    middleware({url: '/plugins/foo/entry.js?import'} as never, response as never, next);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledWith(Buffer.from('asset')));

    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/javascript');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('serves user plugin assets and falls through read failures', async () => {
    const readFile = vi.fn((_filePath: string, callback: (error: NodeJS.ErrnoException) => void) => {
      callback(new Error('missing'));
    });
    const middleware = createPluginServeMiddleware(dirs, {readFile});
    const next = vi.fn();

    middleware({url: '/user-plugins/foo/index.css'} as never, {setHeader: vi.fn(), end: vi.fn()} as never, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(readFile).toHaveBeenCalledWith('/u/foo/index.css', expect.any(Function));
  });

  it('serves user plugin assets with no-store caching', async () => {
    const readFile = vi.fn((_filePath: string, callback: (error: null, content: Buffer) => void) => {
      callback(null, Buffer.from('user-asset'));
    });
    const middleware = createPluginServeMiddleware(dirs, {readFile});
    const response = {
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    middleware({url: '/user-plugins/foo/index.css'} as never, response as never, next);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledWith(Buffer.from('user-asset')));

    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/css');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).not.toHaveBeenCalled();
  });
});
