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
});
