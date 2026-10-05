import { expect, test } from "@playwright/test";

const VISUAL_LOCALES = ["ja", "en", "ru"] as const;

const PAGES = [
  { path: "/", name: "landing", heading: /PassShare|パスワード/ },
  { path: "/docs", name: "docs", heading: /Documentation|ドキュメント|Документация/i },
  { path: "/app/login", name: "login", heading: /Sign in|ログイン|Вход/i },
  { path: "/faq", name: "faq", heading: /FAQ|よくある質問/i },
  { path: "/terms", name: "terms", heading: /Terms|利用規約|Условия использования/i },
  { path: "/privacy", name: "privacy", heading: /Privacy|プライバシー|Политика конфиденциальности/i },
  { path: "/docs/user-guide", name: "user-guide", heading: /User guide|ユーザーガイド|Руководство пользователя/i },
] as const;

for (const locale of VISUAL_LOCALES) {
  for (const pageDef of PAGES) {
    test(`locale layout: ${pageDef.name} @ ${locale}`, async ({ page }, testInfo) => {
      await page.addInitScript((loc) => {
        window.localStorage.setItem("passshare.locale", loc);
      }, locale);

      await page.goto(pageDef.path);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { name: pageDef.heading }).first()).toBeVisible();

      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(1);

      if (["landing", "privacy", "user-guide"].includes(pageDef.name)) {
        await page.screenshot({ path: testInfo.outputPath(`${pageDef.name}-${locale}.png`), fullPage: true });
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath(`${pageDef.name}-${locale}-320.png`), fullPage: true });
      }
    });
  }
}

test("language switcher exposes ja, en, ru", async ({ page }) => {
  await page.goto("/");
  const langGroup = page.locator(".landing-lang");
  await expect(langGroup.getByRole("button", { name: /日本語/i })).toBeVisible();
  await expect(langGroup.getByRole("button", { name: /^EN$/i })).toBeVisible();
  await expect(langGroup.getByRole("button", { name: /^RU$/i })).toBeVisible();
});

test("ru locale keeps header within viewport", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("passshare.locale", "ru");
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");

  const headerOverflow = await page.locator(".landing-header").evaluate((el) => {
    return el.scrollWidth - el.clientWidth;
  });
  expect(headerOverflow).toBeLessThanOrEqual(1);
});
