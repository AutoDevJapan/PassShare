#!/usr/bin/env node
/**
 * Validates i18n locale JSON key parity against ja.json baseline, and the
 * frontend docs content catalog (frontend/src/content/docs) for MUST-locale
 * completeness so long-form docs never silently fall back for ja/en/ru.
 * Usage: node scripts/i18n-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, "..", "shared", "i18n", "locales");
const repoRoot = path.join(__dirname, "..");

/** MUST-have locales (mirrors MUST_LOCALES in shared/i18n/index.ts). */
const MUST_LOCALES = ["ja", "en", "ru"];

const baseline = JSON.parse(fs.readFileSync(path.join(localesDir, "ja.json"), "utf8"));
const baselineKeys = Object.keys(baseline).sort();

const localeFiles = fs.readdirSync(localesDir).filter((f) => f.endsWith(".json"));
let failed = false;

for (const file of localeFiles) {
  const locale = file.replace(/\.json$/, "");
  const catalog = JSON.parse(fs.readFileSync(path.join(localesDir, file), "utf8"));
  const keys = Object.keys(catalog).sort();

  const missing = baselineKeys.filter((k) => !(k in catalog));
  const extra = keys.filter((k) => !(k in baseline));
  const empty = keys.filter((k) => catalog[k] === "" || catalog[k] === null);

  if (missing.length > 0) {
    failed = true;
    console.error(`[${locale}] missing keys (${missing.length}):`, missing.join(", "));
  }
  if (extra.length > 0) {
    failed = true;
    console.error(`[${locale}] extra keys (${extra.length}):`, extra.join(", "));
  }
  if (empty.length > 0) {
    failed = true;
    console.error(`[${locale}] empty values (${empty.length}):`, empty.join(", "));
  }

  if (missing.length === 0 && extra.length === 0 && empty.length === 0) {
    console.log(`[${locale}] OK (${keys.length} keys)`);
  }
}

// --- Docs content catalog: MUST-locale completeness --------------------------
// The long-form docs (/docs, /faq, /terms, /privacy, user guide) live in
// frontend/src/content/docs as per-locale TS modules registered in index.ts.
// Unlike the JSON locales above they are NOT covered by key parity, so verify
// that every MUST locale ships a docs module and is wired into the catalog.
const docsDir = path.join(repoRoot, "frontend", "src", "content", "docs");
const docsIndexPath = path.join(docsDir, "index.ts");

if (fs.existsSync(docsIndexPath)) {
  const indexSrc = fs.readFileSync(docsIndexPath, "utf8");
  const catalogBlock = indexSrc.match(/catalogs[^=]*=\s*{([\s\S]*?)}/);
  const registered = new Set(
    catalogBlock ? [...catalogBlock[1].matchAll(/(\b[\w-]+)\s*:/g)].map((m) => m[1]) : [],
  );

  for (const locale of MUST_LOCALES) {
    const moduleExists = fs.existsSync(path.join(docsDir, `${locale}.ts`));
    const wired = registered.has(locale);
    if (moduleExists && wired) {
      console.log(`[docs:${locale}] OK (module + catalog entry)`);
    } else {
      failed = true;
      if (!moduleExists) {
        console.error(`[docs:${locale}] missing docs module frontend/src/content/docs/${locale}.ts`);
      }
      if (!wired) {
        console.error(`[docs:${locale}] not registered in frontend/src/content/docs/index.ts catalogs`);
      }
    }
  }
} else {
  failed = true;
  console.error(`[docs] missing catalog index ${path.relative(repoRoot, docsIndexPath)}`);
}

if (failed) {
  process.exit(1);
}

console.log(
  `i18n check passed (${localeFiles.length} locales, ${baselineKeys.length} keys, docs MUST=${MUST_LOCALES.join("/")})`,
);
