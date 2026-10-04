import { defineConfig, devices } from "@playwright/test";

const backendServer = {
  command: "node backend/src/index.js",
  url: "http://127.0.0.1:8080/health",
  reuseExistingServer: !process.env.CI,
  env: {
    APP_ENV: "local",
    PORT: "8080",
    DATABASE_URL: "",
    OP_CONNECT_TOKEN: "",
  },
};

const frontendDevServer = {
  command: "pnpm --dir frontend dev --host 127.0.0.1 --port 5173",
  url: "http://127.0.0.1:5173",
  reuseExistingServer: !process.env.CI,
};

export default defineConfig({
  testDir: "e2e/web",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    launchOptions: { args: ["--disable-gpu"] },
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER ? undefined : [backendServer, frontendDevServer],
  projects: [
    {
      name: "chromium",
      testIgnore: ["i18n-visual.spec.ts", "staging-smoke.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
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
