import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spawn real Hermes workers against real OpenRouter
    // models and share one Postgres — keep everything strictly sequential.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 900_000,
  },
});
