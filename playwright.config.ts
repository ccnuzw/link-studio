import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { trace: "retain-on-failure" },
});
