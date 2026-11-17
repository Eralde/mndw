import {vitePreprocess} from '@sveltejs/vite-plugin-svelte';
import {mndwSvelteWarningFilter} from '@mndw/sdk/svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter: mndwSvelteWarningFilter,
  },
};
