import {vitePreprocess} from '@sveltejs/vite-plugin-svelte';
import {isMndwButtonA11yWarning} from '../../build/svelte-compiler-options.js';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter: (warning) => !isMndwButtonA11yWarning(warning),
  },
};
