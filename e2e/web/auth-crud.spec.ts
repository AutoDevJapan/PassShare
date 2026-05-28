import { expect, test } from "@playwright/test";

test("signup, password box CRUD, and logout", async ({ page }) => {
  const email = `web-e2e-${Date.now()}@example.com`;
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
  await form.getByRole("textbox", { name: /^Title$|^タイトル$/i }).fill("Playwright Login");
  await form.locator('input[type="password"]').fill("secret-value");
  await form.getByRole("button", { name: /^Add$|^追加$/i }).click();

  await expect(page.getByText("Playwright Login")).toBeVisible();

  await page.getByRole("button", { name: /Sign out|ログアウト/i }).click();
  await expect(page).toHaveURL("/");
});
