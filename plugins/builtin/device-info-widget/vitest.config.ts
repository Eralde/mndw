import vue from '@vitejs/plugin-vue';
import {defineMndwVitestProject} from '@mndw/sdk/testing/vitest-project';

export default defineMndwVitestProject({
  environment: 'node',
  setupFiles: ['./vitest.setup.ts'],
  plugins: [vue({template: {compilerOptions: {isCustomElement: (tag) => tag.startsWith('mndw-')}}})],
});
