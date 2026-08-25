import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests for the admin console.
 *
 * Runs against the BUILT app served by `vite preview`, not the dev server, so
 * what is under test is what ships. There is no API here: every spec mocks the
 * backend with `page.route` / `page.routeWebSocket` (see tests/e2e/mockBackend.ts).
 *
 * Run: `npm run build && npm run e2e`
 * First run: `npx playwright install chromium webkit`
 *
 * WebKit is not decoration. The widget suite has caught Safari-only failures
 * that Chromium passed, and Phase 7 adds Intl-dependent date/number output
 * plus a Devanagari font path, both of which are exactly where the engines
 * diverge.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    // 127.0.0.1, not `localhost`: WebKit on macOS resolves `localhost` to ::1
    // first and the preview server binds IPv4 only, so every navigation hit a
    // 30s timeout while Chromium passed. A literal address removes the
    // resolution step entirely.
    baseURL: 'http://127.0.0.1:4174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // WebKit is defined and runnable (`npx playwright test --project=webkit`,
  // or E2E_WEBKIT=1) but is NOT in the default run yet.
  //
  // It crashes the page process inside `mockBackend`, before any assertion:
  // title goes empty and the context closes. Narrowed on 2026-08-25 to the
  // mock itself, not the browser and not Phase 7. Individually verified as
  // fine under WebKit: a trivial page, the built app at /login, the
  // external-origin abort route, and `page.routeWebSocket`. The suite has only
  // ever run Chromium, so this is a latent incompatibility WebKit exposed
  // rather than a regression.
  //
  // Listing it in the default run would make `npm run e2e` permanently red and
  // train people to ignore it. It stays opt-in until the mock is fixed, which
  // is its own piece of work.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.E2E_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
  webServer: {
    // Port 4174 so this never collides with the widget suite on 4173.
    command: 'npx vite preview --port 4174 --host 127.0.0.1',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
