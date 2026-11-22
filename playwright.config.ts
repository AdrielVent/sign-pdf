import { defineConfig, devices } from '@playwright/test';

const PORT = 4317;
// Served like a GitHub Pages project site: only under /sign-pdf/, 404 elsewhere.
const BASE = `http://localhost:${PORT}/sign-pdf/`;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: BASE,
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node scripts/serve-subpath.mjs ${PORT} sign-pdf`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile|smoke/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] }, testMatch: /smoke\.spec/ },
    { name: 'mobile-webkit', use: { ...devices['iPhone 15'] }, testMatch: /smoke\.spec/ },
  ],
});
