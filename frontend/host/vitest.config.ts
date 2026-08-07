import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

const sandboxVirtualTestModules = {
  name: 'mndw-vitest-sandbox-virtual-modules',
  resolveId(id: string): string | undefined {
    if (id === 'virtual:sandbox-plugin') {
      return '\0mndw-vitest-sandbox-plugin';
    }

    if (id === 'virtual:sandbox-manifest') {
      return '\0mndw-vitest-sandbox-manifest';
    }

    return undefined;
  },
  load(id: string): string | undefined {
    if (id === '\0mndw-vitest-sandbox-plugin') {
      return 'export const createInstance = undefined;';
    }

    if (id === '\0mndw-vitest-sandbox-manifest') {
      return 'export default null;';
    }

    return undefined;
  },
};

export default defineConfig({
  plugins: [sandboxVirtualTestModules, svelte({hot: false})],
  resolve: {
    // Resolve the browser build of Svelte so runes and `mount()` work under happy-dom.
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
