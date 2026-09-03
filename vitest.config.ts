import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.{ts,tsx}'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000
  }
});
