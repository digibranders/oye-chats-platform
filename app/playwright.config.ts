import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests for the admin console.
 *
 * Runs against the BUILT app served by `vite preview`, not the dev server, so
 * what is under test is what ships. There is no API here: every spec mocks the
 * backend with `page.route` / `page.routeWebSocket` (see tests/e2e/mockBackend.ts).
 *
 * Run: `npm run build && npm run e2e`
 * First run: `npx playwright install chromium`
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Port 4174 so this never collides with the widget suite on 4173.
    command: 'npx vite preview --port 4174',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
