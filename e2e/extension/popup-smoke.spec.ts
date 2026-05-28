import { chromium, expect, test } from "@playwright/test";
import path from "node:path";

const extensionPath = path.resolve("packages/extension/dist");

test("extension popup renders login UI", async () => {
  const context = await chromium.launchPersistentContext("", {
    headless: !process.env.USE_XVFB,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let extensionId = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const worker = context.serviceWorkers()[0];
      if (worker) {
        const match = worker.url().match(/chrome-extension:\/\/([^/]+)/);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
      await context.waitForEvent("serviceworker", { timeout: 500 }).catch(() => undefined);
    }

    expect(extensionId).not.toEqual("");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole("heading", { name: /PassShare|ログイン|Sign in/i })).toBeVisible();
    await expect(popup.locator("input[type='email']")).toBeVisible();
    await expect(popup.locator("input[type='password']")).toBeVisible();
  } finally {
    await context.close();
  }
});
