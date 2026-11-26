import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/canvas-request-cards",
  workers: 1,
  use: { actionTimeout: 5_000, trace: "retain-on-failure" },
});
