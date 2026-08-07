import {defineConfig} from 'vite';

export default defineConfig({
  root: 'playground',
  server: {
    open: true,
    // Allow importing the engine from ../src.
    fs: {allow: ['..']},
  },
});
