import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Fork suites each start their own anvil; keep them from competing for public RPC quota.
    fileParallelism: false,
  },
});
