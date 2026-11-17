import {svelte} from '@sveltejs/vite-plugin-svelte';
import vue from '@vitejs/plugin-vue';
import {defineConfig} from 'vitest/config';
import {mndwSvelteWarningFilter} from '@mndw/sdk/svelte';

export default defineConfig({
  plugins: [svelte({hot: false, compilerOptions: {warningFilter: mndwSvelteWarningFilter}}), vue()],
  test: {
    testTimeout: 30_000,
  },
  resolve: {
    conditions: ['browser'],
  },
});
