import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('./angular-sandbox-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./angular-sandbox-plugin.js')>();

  return {
    ...actual,
    angularSandboxPlugin: () => ({name: 'mndw-angular-sandbox'}),
  };
});

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

  it('does not register sentinel reload without a sentinel environment variable', () => {
    const config = viteConfig({command: 'serve', mode: 'development', isPreview: false});
    const pluginNames = config.plugins?.map((plugin) => plugin && 'name' in plugin ? plugin.name : undefined);

    expect(pluginNames).not.toContain('mndw-reload-on-sentinel');
  });

  it('registers sentinel reload when the dev supervisor provides its path', () => {
    vi.stubEnv('MNDW_DEV_RELOAD_SENTINEL', path.join(repoRoot, '.dev-data', 'sentinel'));

    const config = viteConfig({command: 'serve', mode: 'development', isPreview: false});
    const pluginNames = config.plugins?.map((plugin) => plugin && 'name' in plugin ? plugin.name : undefined);

    expect(pluginNames).toContain('mndw-reload-on-sentinel');
  });

  it('registers Angular source compilation only for Angular sandbox plugins', () => {
    vi.stubEnv('MNDW_SANDBOX_PLUGIN', path.join(repoRoot, 'plugins/builtin', 'tx-rx-chart-widget'));

    const config = viteConfig({command: 'serve', mode: 'development', isPreview: false});
    const pluginNames = config.plugins?.map((plugin) => plugin && 'name' in plugin ? plugin.name : undefined);

    expect(pluginNames).toContain('mndw-angular-sandbox');
  });

  it('leaves non-Angular sandbox plugins on existing source-HMR path', () => {
    vi.stubEnv('MNDW_SANDBOX_PLUGIN', path.join(repoRoot, 'plugins/builtin', 'clients-widget'));

    const config = viteConfig({command: 'serve', mode: 'development', isPreview: false});
    const pluginNames = config.plugins?.map((plugin) => plugin && 'name' in plugin ? plugin.name : undefined);

    expect(pluginNames).not.toContain('mndw-angular-sandbox');
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

  it('exposes pseudo locale only in development builds', () => {
    const development = viteConfig({command: 'serve', mode: 'development', isPreview: false});
    const production = viteConfig({command: 'build', mode: 'production', isPreview: false});

    expect(development.define?.__MNDW_PSEUDO_LOCALE_ENABLED__).toBe('true');
    expect(production.define?.__MNDW_PSEUDO_LOCALE_ENABLED__).toBe('false');
  });
});
