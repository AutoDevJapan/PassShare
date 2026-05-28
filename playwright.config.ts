import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/web",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "i18n-visual.spec.ts",
      use: { ...devices["Desktop Chrome"] },
      webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
        ? undefined
        : [
            {
              command: "node backend/src/index.js",
              url: "http://127.0.0.1:8080/health",
              reuseExistingServer: !process.env.CI,
              env: {
                APP_ENV: "local",
                PORT: "8080",
              },
            },
            {
              command: "pnpm --dir frontend dev --host 127.0.0.1 --port 5173",
              url: "http://127.0.0.1:5173",
              reuseExistingServer: !process.env.CI,
            },
          ],
    },
    {
      name: "i18n-visual",
      testMatch: "i18n-visual.spec.ts",
      use: { ...devices["Desktop Chrome"] },
      webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
        ? undefined
        : {
            command: "pnpm --dir frontend preview --host 127.0.0.1 --port 5173",
            url: "http://127.0.0.1:5173",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
    },
  ],
});
