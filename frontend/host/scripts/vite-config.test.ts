import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import viteConfig from '../vite.config.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

describe('host Vite config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps workspace root in the filesystem allow list for sandbox source HMR', () => {
    vi.stubEnv('MNDW_SANDBOX_PLUGIN', path.join(repoRoot, 'plugins/builtin', 'clients-widget'));

    const config = viteConfig({command: 'serve', mode: 'development', isPreview: false});

    expect(config.server?.fs?.allow).toContain(repoRoot);
  });

  it('keeps browser origin and disables Vite CORS on daemon proxies', () => {
    const config = viteConfig({command: 'serve', mode: 'development', isPreview: false});
    const apiProxy = config.server?.proxy?.['/api'];
    const wsProxy = config.server?.proxy?.['/ws'];

    expect(config.server?.cors).toBe(false);
    expect(apiProxy && typeof apiProxy !== 'function' && typeof apiProxy !== 'string' && apiProxy.changeOrigin).toBe(
      false,
    );
    expect(wsProxy && typeof wsProxy !== 'function' && typeof wsProxy !== 'string' && wsProxy.changeOrigin).toBe(false);
  });
});
