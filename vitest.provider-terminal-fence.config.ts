import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/provider-acceptance/terminal-fence.pg17.test.ts"],
    environment: "node", pool: "forks", maxWorkers: 1,
    testTimeout: 30_000, hookTimeout: 30_000,
  },
});
