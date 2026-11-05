import {svelte} from '@sveltejs/vite-plugin-svelte';
import vue from '@vitejs/plugin-vue';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [svelte({hot: false}), vue()],
  test: {
    testTimeout: 30_000,
  },
  resolve: {
    conditions: ['browser'],
  },
});
