import { expect, test } from "@playwright/test";

const VISUAL_LOCALES = ["ja", "en", "ru"] as const;

const PAGES = [
  { path: "/", name: "landing", heading: /PassShare|パスワード/ },
  { path: "/docs", name: "docs", heading: /Documentation|ドキュメント/i },
  { path: "/app/login", name: "login", heading: /Sign in|ログイン|Вход/i },
  { path: "/faq", name: "faq", heading: /FAQ|よくある質問/i },
  { path: "/terms", name: "terms", heading: /Terms|利用規約/i },
] as const;

for (const locale of VISUAL_LOCALES) {
  for (const pageDef of PAGES) {
    test(`locale layout: ${pageDef.name} @ ${locale}`, async ({ page }) => {
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
    });
  }
}

test("language switcher exposes ja, en, ru", async ({ page }) => {
  await page.goto("/");
  const langGroup = page.locator(".landing-lang");
  await expect(langGroup.getByRole("button", { name: /日本語/i })).toBeVisible();
  await expect(langGroup.getByRole("button", { name: /^EN$/i })).toBeVisible();
  await expect(langGroup.getByRole("button", { name: /^RU$|Русский/i })).toBeVisible();
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
