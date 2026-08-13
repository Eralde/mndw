import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineConfig} from 'vitest/config';
import {isMndwButtonA11yWarning} from '../../../build/svelte-compiler-options.js';

export default defineConfig({
  plugins: [
    svelte({
      hot: false,
      compilerOptions: {
        warningFilter: (warning) => !isMndwButtonA11yWarning(warning),
      },
    }),
  ],
  resolve: {conditions: ['browser']},
  test: {environment: 'happy-dom', setupFiles: ['./vitest.setup.ts']},
});
