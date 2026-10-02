import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../tests/e2e',
  outputDir: '../tmp/test-results',
  tsconfig: './tsconfig.json',
  timeout: 90000,
  workers: 1,
  use: {
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  },
  reporter: 'list',
});
