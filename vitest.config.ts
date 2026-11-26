import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{src/server,scripts}/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts'],
      exclude: ['**/*.test.ts'],
      reportsDirectory: 'coverage/server',
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
});
