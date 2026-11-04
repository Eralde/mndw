import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';
import {createServer} from 'vite';

import {prebuiltHost} from './dev-server/prebuilt-host.js';

describe('prebuiltHost static middleware', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;

    if (root !== undefined) {
      rmSync(root, {recursive: true, force: true});
      root = undefined;
    }
  });

  async function startServer(): Promise<string> {
    root = mkdtempSync(join(tmpdir(), 'mndw-prebuilt-host-'));

    const hostDir = join(root, 'host');
    const pluginDir = join(root, 'plugin');

    mkdirSync(join(hostDir, 'assets'), {recursive: true});
    mkdirSync(join(pluginDir, 'assets'), {recursive: true});
    writeFileSync(join(hostDir, 'index.html'), '<!doctype html><html><head></head><body>host</body></html>');
    writeFileSync(join(hostDir, 'assets', 'a.js'), 'export default "host asset";');
    writeFileSync(join(pluginDir, 'assets', 'plugin-only.png'), 'plugin asset');

    server = await createServer({
      configFile: false,
      root: pluginDir,
      appType: 'custom',
      plugins: [prebuiltHost(hostDir)],
      server: {host: '127.0.0.1', port: 0, strictPort: true},
    });
    await server.listen();

    const address = server.httpServer?.address();

    if (address === undefined || address === null || typeof address === 'string') {
      throw new Error('Vite server did not bind to a TCP port');
    }

    return `http://127.0.0.1:${address.port}`;
  }

  it('serves host assets and falls through to plugin-root assets', async () => {
    const base = await startServer();
    const hostAsset = await fetch(`${base}/assets/a.js`);
    const pluginAsset = await fetch(`${base}/assets/plugin-only.png`);

    expect(hostAsset.status).toBe(200);
    expect(await hostAsset.text()).toContain('host asset');
    expect(pluginAsset.status).toBe(200);
    expect(await pluginAsset.text()).toContain('plugin asset');
  });

  it.each(['/../package.json', '/%2e%2e/package.json', '/assets/../../x'])(
    'rejects traversal path %s',
    async (path) => {
      const base = await startServer();
      const response = await fetch(`${base}${path}`);

      expect(response.status).toBe(404);
    },
  );

  it('serves the transformed host app for history routes', async () => {
    const base = await startServer();
    const response = await fetch(`${base}/settings/foo`, {headers: {Accept: 'text/html'}});
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('host');
    expect(body).toContain('/@vite/client');
  });
});
