import {describe, expect, it} from 'vitest';
import {resolvePluginRequest} from './serve-plugins.js';

const dirs = {builtinDir: '/b', userDir: '/u'};

describe('resolvePluginRequest', () => {
  it('maps a builtin plugin JS request (stripping the ?import query vite adds)', () => {
    expect(resolvePluginRequest('/plugins/demo-page/index.js?import', dirs)).toEqual({
      filePath: '/b/demo-page/index.js',
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
