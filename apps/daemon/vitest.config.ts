import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Both suites hit the same real Postgres; keep files sequential.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 120_000,
  },
});
