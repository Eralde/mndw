import {describe, expect, it} from 'vitest';

import {pluginDependencies} from '@mndw/sdk-internal/shared-dependencies';
import {startPluginDevServer} from './start.js';

const FIXTURES = new URL('../../fixtures/', import.meta.url).pathname;

describe('startPluginDevServer', () => {
  it('serves Vue production-SFC output while leaving dependency discovery enabled', async () => {
    const handle = await startPluginDevServer({
      pluginDir: `${FIXTURES}dev-plugin-vue`,
      hostBundleDir: `${FIXTURES}dev-plugin-vue`,
      port: 36001,
      daemonUrl: 'http://127.0.0.1:9090',
      framework: 'vue',
    });

    try {
      expect(handle.url).toBe('http://127.0.0.1:36001/');

      const response = await fetch(new URL('/src/App.vue', handle.url));
      const code = await response.text();

      expect(response.status).toBe(200);
      expect(code).toContain('__VUE_HMR_RUNTIME__');
      expect(code).toContain('shared/vue@');
      expect(code).toContain('shared/mndw-ui@');
      expect(code).not.toContain('/.vite/deps/');
    } finally {
      await handle.close();
    }
  });

  it('serves the Svelte plugin entry without forcing author CJS includes', async () => {
    const handle = await startPluginDevServer({
      pluginDir: `${FIXTURES}dev-plugin-svelte`,
      hostBundleDir: `${FIXTURES}dev-plugin-svelte`,
      port: 36002,
      daemonUrl: 'http://127.0.0.1:9090',
      framework: 'svelte',
    });

    try {
      const response = await fetch(new URL('/@mndw-dev/plugin.js', handle.url));
      const code = await response.text();

      expect(response.status).toBe(200);
      expect(code).toContain('/src/index.ts');
      expect(pluginDependencies('svelte')).not.toContain('cjs-probe');
    } finally {
      await handle.close();
    }
  }, 15000);
});
