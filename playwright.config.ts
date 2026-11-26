import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: process.env.FACTORY_SMOKE_URL ?? 'http://127.0.0.1:3000',
    viewport: { width: 1080, height: 720 },
  },
});
