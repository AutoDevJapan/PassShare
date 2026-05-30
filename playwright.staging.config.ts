import { defineConfig, devices } from "@playwright/test";

const stagingUrl = process.env.STG_WEB_URL ?? process.env.PLAYWRIGHT_BASE_URL;

if (!stagingUrl) {
  throw new Error("STG_WEB_URL or PLAYWRIGHT_BASE_URL is required for staging Playwright config");
}

export default defineConfig({
  testDir: "e2e/web",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: stagingUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "staging-chromium",
      testMatch: "staging-smoke.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
