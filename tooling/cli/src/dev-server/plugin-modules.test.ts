import {readFileSync} from 'node:fs';
import {request} from 'node:http';
import {resolve} from 'node:path';

import {describe, expect, it} from 'vitest';
import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';

import {pluginModules} from './plugin-modules.js';
import {sharedExternals} from './shared-externals.js';

const FIXTURES = resolve(import.meta.dirname, '../../fixtures');

async function get(url: URL, path: string): Promise<{status: number; body: string}> {
  return await new Promise((resolveResponse, reject) => {
    const req = request({hostname: url.hostname, port: url.port, path}, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolveResponse({status: response.statusCode ?? 0, body}));
    });

    req.on('error', reject);
    req.end();
  });
}

describe('pluginModules', () => {
  it('serves the source entry and manifest as HMR-aware virtual modules', async () => {
    const pluginDir = resolve(FIXTURES, 'dev-plugin-vue');
    const server = await createServer({
      root: pluginDir,
      configFile: false,
      appType: 'custom',
      plugins: [vue({isProduction: true}), sharedExternals('vue'), pluginModules(pluginDir)],
      server: {host: '127.0.0.1', port: 35001},
    });

    try {
      await server.listen();

      const pluginModule = await server.transformRequest('/@mndw-dev/plugin.js');
      const manifestModule = await server.transformRequest('/@mndw-dev/manifest.js');
      const transformedCatalog = await server.transformRequest('/i18n/en.json');
      const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'manifest.json'), 'utf8')) as unknown;
      const defaultExport = manifestModule?.code.match(/export default (.*);/)?.[1];
      const catalog = await get(new URL(server.resolvedUrls?.local[0] ?? ''), '/i18n/en.json');

      expect(pluginModule?.code).toMatch(/export\s+\{\s*createInstance\s*\}\s+from\s+/);
      expect(pluginModule?.code).toContain('from "/src/index.ts"');
      expect(pluginModule?.code).toContain('mndw:dev-plugin-update');
      expect(manifestModule?.code).toContain('mndw:dev-manifest-update');
      expect(defaultExport).toBeDefined();

      if (defaultExport === undefined) {
        throw new Error('Manifest module has no default export');
      }

      expect(JSON.parse(defaultExport)).toEqual(manifest);
      expect(manifestModule?.code).toContain('export const __catalogBaseUrl = "/";');
      expect(transformedCatalog?.code).toContain('"Vue fixture"');
      expect(catalog).toEqual({status: 200, body: readFileSync(resolve(pluginDir, 'i18n/en.json'), 'utf8')});
    } finally {
      await server.close();
    }
  });
});
