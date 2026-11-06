import {defineConfig} from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  use: {
    baseURL: 'http://127.0.0.1:4174/mndw/',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'pnpm exec vitepress preview docs/plugin-author --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/mndw/',
    reuseExistingServer: false,
    cwd: path.resolve(__dirname, '../..'),
  },
});
