import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/geometry.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    headless: true,
  },
  projects: [
    {name: 'chromium-geometry', use: {...devices['Desktop Chrome'], browserName: 'chromium'}},
    {name: 'firefox-geometry', use: {...devices['Desktop Firefox'], browserName: 'firefox'}},
    {name: 'webkit-geometry', use: {...devices['Desktop Safari'], browserName: 'webkit'}},
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/e2e/fixtures/geometry.html',
    reuseExistingServer: !process.env.CI,
  },
});
