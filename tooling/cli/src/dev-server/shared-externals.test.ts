import {describe, expect, it} from 'vitest';
import {createServer} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import vue from '@vitejs/plugin-vue';

import {pluginDependencies, sharedImportMap} from '@mndw/sdk-internal/shared-dependencies';
import {sharedExternals} from './shared-externals.js';

const FIXTURES = new URL('../../fixtures/', import.meta.url).pathname;

describe('sharedExternals', () => {
  it('rewrites Vue shared imports to same-origin host URLs', async () => {
    const server = await createServer({
      root: `${FIXTURES}dev-plugin-vue`,
      configFile: false,
      appType: 'custom',
      optimizeDeps: {exclude: pluginDependencies('vue')},
      plugins: [vue({isProduction: true}), sharedExternals('vue')],
      server: {origin: 'http://127.0.0.1:4173', middlewareMode: true},
    });

    try {
      const transformed = await server.transformRequest('/src/App.vue');

      expect(transformed?.code).toContain(new URL(sharedImportMap().vue, 'http://127.0.0.1:4173').href);
      expect(transformed?.code).toContain(new URL(sharedImportMap()['@mndw/ui'], 'http://127.0.0.1:4173').href);
      expect(transformed?.code).not.toContain('/node_modules/');
      expect(transformed?.code).not.toContain('/.vite/deps/');
    } finally {
      await server.close();
    }
  });

  it('keeps Svelte local while rewriting its other host-shared imports', async () => {
    const server = await createServer({
      root: `${FIXTURES}dev-plugin-svelte`,
      configFile: false,
      appType: 'custom',
      optimizeDeps: {exclude: pluginDependencies('svelte'), noDiscovery: true, include: []},
      plugins: [svelte(), sharedExternals('svelte')],
      server: {origin: 'http://127.0.0.1:4175', middlewareMode: true},
    });

    try {
      const transformed = await server.transformRequest('/src/App.svelte');

      expect(transformed?.code).toMatch(/\.vite\/deps\/svelte_internal_client\.js/);
      expect(transformed?.code).not.toContain('shared/svelte@');
      expect(transformed?.code).toContain(new URL(sharedImportMap()['@mndw/ui'], 'http://127.0.0.1:4175').href);
      expect(transformed?.code).toContain(new URL(sharedImportMap()['rxjs/operators'], 'http://127.0.0.1:4175').href);
    } finally {
      await server.close();
    }
  });
});
