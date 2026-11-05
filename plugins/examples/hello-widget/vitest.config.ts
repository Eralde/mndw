import {svelte} from '@sveltejs/vite-plugin-svelte';
import {defineMndwVitestProject} from '@mndw/sdk/testing/vitest-project';
import {isMndwButtonA11yWarning} from '../../../build/svelte-compiler-options.js';

export default defineMndwVitestProject({
  environment: 'happy-dom',
  resolve: {conditions: ['browser']},
  setupFiles: ['./vitest.setup.ts'],
  plugins: [svelte({hot: false, compilerOptions: {warningFilter: (warning) => !isMndwButtonA11yWarning(warning)}})],
});
