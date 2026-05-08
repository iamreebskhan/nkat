/**
 * Playwright config for the browser-extension E2E suite. The MV3 service
 * worker only loads inside a *persistent* Chromium context with the
 * `--load-extension` flag, so each spec opens its own fresh user-data dir
 * via `chromium.launchPersistentContext(...)`.
 *
 * Run:
 *   npm run build            # produce dist/ (manifest + bundles)
 *   npx playwright install chromium
 *   npm run test:e2e
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: false, // extension contexts are heavy + chatty
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    headless: false, // MV3 service worker doesn't boot in --headless=new before 121
    trace: 'retain-on-failure',
  },
});
