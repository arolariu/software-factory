import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/{server,shared}/**/*.test.ts'],
    exclude: ['**/*.image.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/{server,shared}/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reportsDirectory: 'coverage/server',
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
});
