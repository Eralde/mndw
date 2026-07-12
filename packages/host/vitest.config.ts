import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [svelte({hot: false})],
  resolve: {
    // Resolve the browser build of Svelte so runes and `mount()` work under happy-dom.
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
