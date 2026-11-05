import {resolve} from 'node:path';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

const hostNodeModules = resolve(import.meta.dirname, 'node_modules');

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
    // Packed plugins live outside host's package root, so their external shared imports need
    // explicit workspace aliases when consumed by Vitest.
    alias: {
      '@angular/common': resolve(hostNodeModules, '@angular/common'),
      '@angular/compiler': resolve(hostNodeModules, '@angular/compiler'),
      '@angular/core/rxjs-interop': resolve(hostNodeModules, '@angular/core/fesm2022/rxjs-interop.mjs'),
      '@angular/core': resolve(hostNodeModules, '@angular/core'),
      '@angular/platform-browser': resolve(hostNodeModules, '@angular/platform-browser'),
      '@mndw/ui': resolve(hostNodeModules, '@mndw/ui'),
      '@rci-tools/core': resolve(hostNodeModules, '@rci-tools/core'),
      'd3': resolve(hostNodeModules, 'd3'),
      'rxjs': resolve(hostNodeModules, 'rxjs'),
      'vue': resolve(hostNodeModules, 'vue'),
      'zone.js': resolve(hostNodeModules, 'zone.js'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
