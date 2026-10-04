import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openBox(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const signup = await page.request.post("/api/auth/signup", {
    headers: { "X-CSRF-Token": csrf.csrfToken },
    data: { email: `reliability-${crypto.randomUUID()}@example.com`, password: "SyntheticTest123!" },
  });
  expect(signup.status()).toBe(201);
  const token = (await (await page.request.get("/api/auth/connect-token")).json()).accessToken;
  const headers = { Authorization: `Bearer ${token}` };
  const boxes = await (await page.request.get("/v1/vaults", { headers })).json();
  expect(boxes).toHaveLength(1);
  const path = `/v1/vaults/${boxes[0].id}/items`;
  return { path, headers, url: `/app/vaults/${boxes[0].id}/items` };
}

test("editing keeps imported fields, URLs and metadata and rejects a stale edit", async ({ page }, testInfo) => {
  const box = await openBox(page);
  const seeded = await page.request.post(box.path, { headers: box.headers, data: {
    title: "Imported record", category: "LOGIN", favorite: true, tags: ["work, shared"],
    sections: [{ id: "extra", label: "Extra" }], files: [{ id: "fixture-file", name: "fixture.txt" }],
    fields: [
      { id: "a".repeat(26), label: "username", type: "STRING", purpose: "USERNAME", value: "test-user" },
      { id: "b".repeat(26), label: "password", type: "CONCEALED", purpose: "PASSWORD", value: "synthetic-only" },
      { id: "c".repeat(26), label: "otp", type: "OTP", section: { id: "extra" }, value: "synthetic-otp" },
      { id: "d".repeat(26), label: "notes", type: "STRING", value: "clear this note" },
    ],
    urls: [{ href: "https://primary.example", primary: true, label: "Primary" }, { href: "https://secondary.example", primary: false, label: "Secondary" }],
  } });
  expect(seeded.status()).toBe(201);
  const original = await seeded.json();
  await page.goto(box.url);
  await page.getByRole("button", { name: /^Edit$|^編集$/ }).click();
  const form = page.locator(".ps-card--form");
  await form.getByRole("textbox", { name: /^Title$|^タイトル$/ }).fill("Edited record");
  await form.getByRole("textbox", { name: /^Notes$|^メモ$/ }).fill("");
  await form.getByRole("button", { name: /^Save$|^保存$/ }).click();
  await expect(page.getByText("Edited record", { exact: true })).toBeVisible();
  const saved = await (await page.request.get(`${box.path}/${original.id}`, { headers: box.headers })).json();
  expect(saved.fields).toEqual(original.fields.map((field: { label: string }) => field.label === "notes" ? { ...field, value: "" } : field));
  expect(saved.urls).toEqual(original.urls);
  expect(saved.sections).toEqual(original.sections);
  expect(saved.files).toEqual(original.files);
  expect(saved.tags).toEqual(original.tags);
  expect(saved.favorite).toBe(true);
  expect(saved.version).toBe(original.version + 1);

  await page.getByRole("button", { name: /^Edit$|^編集$/ }).click();
  await form.getByRole("textbox", { name: /^Title$|^タイトル$/ }).fill("My unsaved edit");
  const other = await page.request.put(`${box.path}/${original.id}`, { headers: box.headers, data: { ...saved, title: "Other person's edit" } });
  expect(other.status()).toBe(200);
  await form.getByRole("button", { name: /^Save$|^保存$/ }).click();
  await expect(page.getByRole("alert")).toContainText(/Someone else|ほかの人/);
  await expect(form.getByRole("textbox", { name: /^Title$|^タイトル$/ })).toHaveValue("My unsaved edit");
  expect((await (await page.request.get(`${box.path}/${original.id}`, { headers: box.headers })).json()).title).toBe("Other person's edit");
  await page.screenshot({ path: testInfo.outputPath("edit-conflict.png"), fullPage: true });
  await page.getByRole("button", { name: /Refresh list|一覧を更新/ }).click();
  await expect(page.getByText("Other person's edit", { exact: true })).toBeVisible();
  await expect(form.getByRole("textbox", { name: /^Title$|^タイトル$/ })).toHaveValue("My unsaved edit");
  await form.getByRole("button", { name: /^Cancel$|^キャンセル$/ }).click();
  await page.getByRole("button", { name: /^Edit$|^編集$/ }).click();
  await expect(form.getByRole("textbox", { name: /^Title$|^タイトル$/ })).toHaveValue("Other person's edit");
});

test("failed save retains input and blocks duplicate submissions until completion", async ({ page }) => {
  const box = await openBox(page);
  await page.goto(box.url);
  const form = page.locator(".ps-card--form");
  await expect(form.getByRole("button", { name: /^Add$|^追加$/ })).toBeEnabled();
  await form.getByRole("textbox", { name: /^Title$|^タイトル$/ }).fill("Keep this input");
  await form.locator('input[type="password"]').fill("synthetic-only");
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**${box.path}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls += 1;
    await gate;
    await route.fulfill({ status: 503, json: { message: "Synthetic failure" } });
  });
  await form.getByRole("button", { name: /^Add$|^追加$/ }).click();
  await expect(form.getByRole("button", { name: /^Add$|^追加$/ })).toBeDisabled();
  await expect(form.getByRole("textbox", { name: /^Title$|^タイトル$/ })).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText(/Could not save|保存できません/);
  await expect(form.getByRole("textbox", { name: /^Title$|^タイトル$/ })).toHaveValue("Keep this input");
  await expect(form.locator('input[type="password"]')).toHaveValue("synthetic-only");
  expect(calls).toBe(1);
  await page.unroute(`**${box.path}`);
  await form.getByRole("button", { name: /^Add$|^追加$/ }).click();
  await expect(page.getByText("Keep this input", { exact: true })).toBeVisible();
  expect(await (await page.request.get(box.path, { headers: box.headers })).json()).toHaveLength(1);
});

test("failed detail load disables incomplete CSV export and can be retried", async ({ page }) => {
  const box = await openBox(page);
  const created = await (await page.request.post(box.path, { headers: box.headers, data: { title: "Existing record", category: "SECURE_NOTE", fields: [{ label: "notes", type: "STRING", value: "synthetic note" }] } })).json();
  await page.route(`**${box.path}/${created.id}`, (route) => route.fulfill({ status: 503, json: { message: "Synthetic failure" } }));
  await page.goto(box.url);
  await expect(page.getByRole("alert")).toContainText(/Failed to load|読み込み|取得/);
  await expect(page.getByRole("button", { name: /Export 1Password CSV|CSV.*エクスポート/ })).toBeDisabled();
  await page.unroute(`**${box.path}/${created.id}`);
  await page.getByRole("button", { name: /Refresh list|一覧を更新/ }).click();
  await expect(page.getByText("Existing record", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Export 1Password CSV|CSV.*エクスポート/ })).toBeEnabled();
});

test("CSV import reports created rows after partial failure and delete errors stay visible", async ({ page }) => {
  const box = await openBox(page);
  await page.goto(box.url);
  await expect(page.getByRole("button", { name: /Import 1Password CSV|CSV.*インポート/ })).toBeEnabled();
  let calls = 0;
  await page.route(`**${box.path}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls += 1;
    if (calls === 2) return route.fulfill({ status: 503, json: { message: "Synthetic failure" } });
    await route.continue();
  });
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Title,Username,Password,URL,Notes,Tags\nFirst,user,synthetic,,,,\nSecond,user,synthetic,,,,\n") });
  await expect(page.getByRole("alert")).toContainText(/creating 1 items|1件を作成済み/);
  await expect(page.getByText("First", { exact: true })).toBeVisible();
  expect(await (await page.request.get(box.path, { headers: box.headers })).json()).toHaveLength(1);
  await page.route(`**${box.path}/*`, (route) => route.request().method() === "DELETE" ? route.fulfill({ status: 403, json: { message: "Synthetic denial" } }) : route.continue());
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^Delete$|^削除$/ }).click();
  await expect(page.getByRole("alert")).toContainText(/Could not delete|削除できません/);
  await expect(page.getByText("First", { exact: true })).toBeVisible();
});

test("editing a structured category preserves fields when no body was present", async ({ page }) => {
  const box = await openBox(page);
  const created = await (await page.request.post(box.path, { headers: box.headers, data: {
    title: "Imported card", category: "CREDIT_CARD", tags: [],
    fields: [{ id: "e".repeat(26), label: "number", type: "CONCEALED", value: "synthetic-number" }],
  } })).json();
  await page.goto(box.url);
  await page.getByRole("button", { name: /^Edit$|^編集$/ }).click();
  const form = page.locator(".ps-card--form");
  await form.getByRole("textbox", { name: /^Title$|^タイトル$/ }).fill("Renamed card");
  await form.getByRole("button", { name: /^Save$|^保存$/ }).click();
  await expect(page.getByText("Renamed card", { exact: true })).toBeVisible();
  const saved = await (await page.request.get(`${box.path}/${created.id}`, { headers: box.headers })).json();
  expect(saved.fields).toEqual(created.fields);
  expect(saved.category).toBe("CREDIT_CARD");
});

test("secure note body survives editing and CSV export even with an empty notes field", async ({ page }) => {
  const box = await openBox(page);
  const created = await (await page.request.post(box.path, { headers: box.headers, data: {
    title: "Body-only note", category: "SECURE_NOTE", tags: [],
    fields: [
      { id: "f".repeat(26), label: "notes", type: "STRING", value: "" },
      { id: "g".repeat(26), label: "body", type: "STRING", value: "synthetic note body" },
    ],
  } })).json();
  await page.goto(box.url);
  await page.getByRole("button", { name: /^Edit$|^編集$/ }).click();
  const form = page.locator(".ps-card--form");
  await form.getByRole("textbox", { name: /^Body$|^本文$/ }).fill("Edited synthetic body");
  await form.getByRole("button", { name: /^Save$|^保存$/ }).click();
  await expect(form.getByRole("heading", { name: /Add item|項目を追加/ })).toBeVisible();
  const saved = await (await page.request.get(`${box.path}/${created.id}`, { headers: box.headers })).json();
  expect(saved.fields).toEqual([created.fields[0], { ...created.fields[1], value: "Edited synthetic body" }]);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toMatch(/plaintext|平文/);
    await dialog.accept();
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /Export 1Password CSV|CSV.*エクスポート/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toContain("Edited synthetic body");
});
