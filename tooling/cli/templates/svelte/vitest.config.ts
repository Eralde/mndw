import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';
import {mndwSvelteWarningFilter} from '@mndw/sdk/svelte';

export default defineConfig({
  plugins: [svelte({hot: false, compilerOptions: {warningFilter: mndwSvelteWarningFilter}})],
  resolve: {
    conditions: ['browser'],
  },
});
