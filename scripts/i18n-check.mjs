#!/usr/bin/env node
/**
 * Validates i18n locale JSON key parity against ja.json baseline.
 * Usage: node scripts/i18n-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, "..", "shared", "i18n", "locales");

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

if (failed) {
  process.exit(1);
}

console.log(`i18n check passed (${localeFiles.length} locales, ${baselineKeys.length} keys)`);
