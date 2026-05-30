import { expect, test } from "@playwright/test";

/**
 * Deployed Web UI smoke (Issue #207).
 * Requires STG_WEB_URL (Vercel Preview / stg). Uses dynamic signup to avoid shared credentials.
 */
test("staging: signup, password box CRUD, logout", async ({ page }) => {
  const email = `stg-smoke-${Date.now()}@example.com`;
  const password = "TestPass123!";

  await page.goto("/app/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /Create account|アカウント作成/i }).click();

  await expect(page).toHaveURL(/\/app\/vaults/);
  await expect(page.getByRole("heading", { name: /Password boxes|パスワードボックス/i })).toBeVisible();

  await page.getByRole("link", { name: "My Password Box" }).click();
  await expect(page).toHaveURL(/\/items$/);

  const form = page.locator(".ps-card--form");
  await form.getByRole("textbox", { name: /^Title$|^タイトル$/i }).fill("Staging Smoke Login");
  await form.locator('input[type="password"]').fill("staging-secret");
  await form.getByRole("button", { name: /^Add$|^追加$/i }).click();

  await expect(page.getByText("Staging Smoke Login")).toBeVisible();

  await page.getByRole("button", { name: /Sign out|ログアウト/i }).click();
  await expect(page).toHaveURL("/");
});
