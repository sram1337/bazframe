import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000
  }
});
