import vue from '@vitejs/plugin-vue';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [vue({template: {compilerOptions: {isCustomElement: (tag) => tag.startsWith('mndw-')}}})],
  test: {environment: 'node', setupFiles: ['./vitest.setup.ts']},
});
