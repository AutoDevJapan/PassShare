import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/extension",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-extension",
      use: {
        headless: true,
        trace: "on-first-retry",
      },
    },
  ],
});
