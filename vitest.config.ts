import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      "tests/accesslease.spec.ts",
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/negative-controls/**/*.test.ts",
      "tests/web/**/*.test.tsx",
    ],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 90_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      // Every application module counts: domain, services, worker, connectors, API, CLI commands and web UI.
      include: ["src/**/*.{ts,tsx}"],
      // cli.ts is a thin process wrapper around commands.ts; main.tsx only mounts <App/>.
      exclude: ["src/cli.ts", "src/web/main.tsx", "src/web/env.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
