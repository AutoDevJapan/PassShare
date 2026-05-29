#!/usr/bin/env node
/**
 * Validates shared CSS against jp-ui-contracts reject conditions.
 * Usage: node scripts/jp-ui-contracts-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const stylesDir = path.join(root, "shared", "styles");

const STYLE_FILES = [
  "tokens.css",
  "typography.css",
  "locale.css",
  "components.css",
  "matrix.css",
];

const WEB_UI_GLOBS = [
  "frontend/src",
  "shared/ui",
];

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;
const UNICODE_ICON_PATTERN = /[★☆✓✔✗✘⚡◆◇●○■□▲▼]/;

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const passes = [];

function readStyle(name) {
  return fs.readFileSync(path.join(stylesDir, name), "utf8");
}

function walkTsx(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkTsx(full, out);
    } else if (/\.(tsx|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 1. Global word-break: break-all
for (const file of STYLE_FILES) {
  const css = stripComments(readStyle(file));
  if (/word-break\s*:\s*break-all/.test(css)) {
    failures.push(`[1] ${file}: word-break: break-all detected`);
  }
}
if (!failures.some((f) => f.startsWith("[1]"))) {
  passes.push("[1] No global word-break: break-all in shared styles");
}

// 2. Strong letter-spacing on body text
{
  const typography = stripComments(readStyle("typography.css"));
  const bodyBlock = typography.match(/\.ps-body\s*\{[^}]+\}/);
  if (bodyBlock && /letter-spacing\s*:\s*0\.0[3-9]|letter-spacing\s*:\s*var\(--ps-tracking-wide\)/.test(bodyBlock[0])) {
    failures.push("[2] typography.css: .ps-body has strong letter-spacing (>0.02em)");
  } else {
    passes.push("[2] .ps-body letter-spacing is conservative");
  }
}

// 3. Japanese body line-height >= 1.5 (target 1.7–2.0)
{
  const tokens = readStyle("tokens.css");
  const match = tokens.match(/--ps-leading-ja:\s*([\d.]+)/);
  const leading = match ? Number.parseFloat(match[1]) : 0;
  if (leading < 1.7 || leading > 2.0) {
    failures.push(`[3] tokens.css: --ps-leading-ja=${leading} (expected 1.7–2.0)`);
  } else {
    passes.push(`[3] Japanese body line-height ${leading} within jp-ui-contracts range`);
  }
}

// 4. Explicit Japanese font fallback
{
  const tokens = readStyle("tokens.css");
  if (!/--ps-font-sans-cjk:[^;]*Noto Sans JP|Hiragino/.test(tokens)) {
    failures.push("[4] tokens.css: missing explicit Japanese font stack (--ps-font-sans-cjk)");
  } else {
    passes.push("[4] Explicit Japanese font fallback in token stack");
  }
}

// 5. Global palt / font-feature-settings on body
{
  const locale = stripComments(readStyle("locale.css"));
  const typography = stripComments(readStyle("typography.css"));
  const combined = `${locale}\n${typography}`;
  if (/\.ps-body[^}]*font-feature-settings[^}]*palt/.test(combined) || /html:lang\(ja\)[^{]*\{[^}]*palt/.test(combined)) {
    failures.push("[5] Global palt applied to body text without scoped heading rule");
  } else {
    passes.push("[5] No global palt on body text");
  }
}

// 6. Form/table density separation from body rules
{
  const locale = readStyle("locale.css");
  const hasForm = /--ps-leading-form/.test(locale) && /\.ps-label/.test(locale);
  const hasTable = /\.ps-card--list|\.app-vault-card|min-height:\s*3\.25rem/.test(locale);
  if (!hasForm || !hasTable) {
    failures.push("[6] locale.css: form/table density rules missing");
  } else {
    passes.push("[6] Form and table density separated from body typography");
  }
}

// 7. Lucide-style icons — no emoji / Unicode symbol icons in Web UI components
{
  const uiFiles = WEB_UI_GLOBS.flatMap((rel) => walkTsx(path.join(root, rel)));
  const offenders = [];
  for (const file of uiFiles) {
    const content = fs.readFileSync(file, "utf8");
    if (EMOJI_PATTERN.test(content) || UNICODE_ICON_PATTERN.test(content)) {
      offenders.push(path.relative(root, file));
    }
  }
  if (offenders.length > 0) {
    failures.push(`[7] Emoji/Unicode icon substitutes in UI: ${offenders.join(", ")}`);
  } else {
    passes.push("[7] Web/shared UI components free of emoji and Unicode icon substitutes");
  }
}

for (const line of passes) {
  console.log(`PASS ${line}`);
}

if (failures.length > 0) {
  for (const line of failures) {
    console.error(`FAIL ${line}`);
  }
  process.exit(1);
}

console.log(`jp-ui-contracts check passed (${passes.length}/7 items)`);
