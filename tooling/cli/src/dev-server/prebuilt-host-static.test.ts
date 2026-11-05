import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createServer} from 'vite';

import {prebuiltHost} from './prebuilt-host.js';

const temporaryDirectories: string[] = [];

function createFixture(): {pluginDir: string; hostDir: string} {
  const root = mkdtempSync(join(tmpdir(), 'mndw-prebuilt-host-'));

  temporaryDirectories.push(root);

  const pluginDir = join(root, 'plugin');
  const hostDir = join(root, 'host');

  mkdirSync(join(pluginDir, 'assets'), {recursive: true});
  mkdirSync(join(hostDir, 'assets'), {recursive: true});
  writeFileSync(join(pluginDir, 'assets/plugin-only.png'), 'plugin asset');
  writeFileSync(join(hostDir, 'assets/a.js'), 'host asset');
  writeFileSync(join(hostDir, 'index.html'), '<html><body>prebuilt host</body></html>');

  return {pluginDir, hostDir};
}

async function requestRaw(url: URL, path: string, accept?: string): Promise<{status: number; body: string}> {
  return await new Promise((resolve, reject) => {
    const headers = accept === undefined ? {} : {accept};
    const req = request({hostname: url.hostname, port: url.port, path, headers}, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({status: response.statusCode ?? 0, body}));
    });

    req.on('error', reject);
    req.end();
  });
}

async function requestPrebuiltScript(): Promise<{response: {status: number; body: string}; warmupPaths: string[]}> {
  const {pluginDir, hostDir} = createFixture();

  writeFileSync(
    join(hostDir, 'index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/a.js"></script></head><body></body></html>',
  );

  const server = await createServer({
    root: pluginDir,
    configFile: false,
    appType: 'custom',
    plugins: [prebuiltHost(hostDir)],
    server: {host: '127.0.0.1', port: 35001},
  });

  try {
    await server.listen();

    const url = new URL(server.resolvedUrls?.local[0] ?? '');
    const warmupRequest = vi.spyOn(server, 'warmupRequest');
    const response = await requestRaw(url, '/');

    return {response, warmupPaths: warmupRequest.mock.calls.map(([path]) => path)};
  } finally {
    await server.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe('prebuiltHost', () => {
  it('serves host assets and falls through to plugin-root assets', async () => {
    const {pluginDir, hostDir} = createFixture();
    const server = await createServer({
      root: pluginDir,
      configFile: false,
      appType: 'custom',
      plugins: [prebuiltHost(hostDir)],
      server: {host: '127.0.0.1', port: 32001},
    });

    try {
      await server.listen();

      const url = new URL(server.resolvedUrls?.local[0] ?? '');
      const hostAsset = await requestRaw(url, '/assets/a.js');
      const pluginAsset = await requestRaw(url, '/assets/plugin-only.png');

      expect(hostAsset).toEqual({status: 200, body: 'host asset'});
      expect(pluginAsset).toEqual({status: 200, body: 'plugin asset'});
    } finally {
      await server.close();
    }
  });

  it.each(['/../package.json', '/%2e%2e/package.json', '/assets/../../x'])(
    'rejects traversal path %s',
    async (path) => {
      const {pluginDir, hostDir} = createFixture();
      const server = await createServer({
        root: pluginDir,
        configFile: false,
        appType: 'custom',
        plugins: [prebuiltHost(hostDir)],
        server: {host: '127.0.0.1', port: 32002 + Math.floor(Math.random() * 2000)},
      });

      try {
        await server.listen();

        const url = new URL(server.resolvedUrls?.local[0] ?? '');

        expect(await requestRaw(url, path)).toMatchObject({status: 404});
      } finally {
        await server.close();
      }
    },
  );

  it('serves history navigation through transformIndexHtml', async () => {
    const {pluginDir, hostDir} = createFixture();
    const server = await createServer({
      root: pluginDir,
      configFile: false,
      appType: 'custom',
      plugins: [prebuiltHost(hostDir)],
      server: {host: '127.0.0.1', port: 34001},
    });

    try {
      await server.listen();

      const url = new URL(server.resolvedUrls?.local[0] ?? '');
      const response = await requestRaw(url, '/settings/foo', 'text/html');

      expect(response.status).toBe(200);
      expect(response.body).toContain('prebuilt host');
      expect(response.body).toContain('/@vite/client');
    } finally {
      await server.close();
    }
  });
});

describe('prebuiltHost production assets', () => {
  it('does not pre-transform production scripts from the prebuilt host', async () => {
    const {response, warmupPaths} = await requestPrebuiltScript();

    expect(response.status).toBe(200);
    expect(response.body).toContain('src="/assets/a.js"');
    expect(response.body).not.toContain('vite-ignore');
    expect(warmupPaths).not.toContain('/assets/a.js');
  });
});
