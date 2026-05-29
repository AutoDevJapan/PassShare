#!/usr/bin/env node
/**
 * Exports locale copy for Pencil i18n design frames (Issue #130).
 * Usage: node scripts/export-i18n-design-copy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const localesDir = path.join(root, "shared", "i18n", "locales");
const outDir = path.join(root, "design", "pencil-i18n");
const outFile = path.join(outDir, "locale-copy.json");

const LOCALES = ["ja", "en", "ru"];
const SCREENS = {
  landing: {
    path: "/",
    keys: [
      "header.nav.home",
      "header.nav.docs",
      "header.nav.app",
      "header.search.placeholder",
      "header.lang.ja",
      "header.lang.en",
      "header.cta.download",
      "hero.badge",
      "hero.title.line1",
      "hero.title.line2",
      "hero.lead.prefix",
      "hero.lead.box",
      "hero.lead.suffix",
      "hero.cta.download",
      "hero.cta.docs",
      "footer.tagline.prefix",
      "footer.tagline.box",
      "footer.tagline.suffix",
      "footer.faq",
      "footer.terms",
    ],
  },
  docs: {
    path: "/docs",
    keys: ["header.nav.docs", "footer.documentation"],
    docPage: "hub",
  },
  login: {
    path: "/app/login",
    keys: [
      "app.auth.loginTitle",
      "session.email",
      "session.password",
      "session.login",
      "app.auth.signupLink",
      "app.auth.resetLink",
    ],
  },
  faq: {
    path: "/faq",
    docPage: "faq",
  },
  terms: {
    path: "/terms",
    docPage: "terms",
  },
};

function loadLocale(locale) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), "utf8"));
}

function loadDocTitles(locale, page) {
  const modPath = path.join(root, "frontend", "src", "content", "docs", `${locale}.ts`);
  if (!fs.existsSync(modPath)) {
    return null;
  }
  const source = fs.readFileSync(modPath, "utf8");
  const pageMatch = source.match(new RegExp(`${page}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`, "m"));
  if (!pageMatch) return null;
  const block = pageMatch[1];
  const title = block.match(/title:\s*"([^"]+)"/)?.[1] ?? "";
  const lead = block.match(/lead:\s*"([^"]+)"/)?.[1] ?? "";
  const sectionTitles = [...block.matchAll(/title:\s*"([^"]+)"/g)].slice(1).map((m) => m[1]);
  return { title, lead, sectionTitles: sectionTitles.slice(0, 3) };
}

const catalogs = Object.fromEntries(LOCALES.map((l) => [l, loadLocale(l)]));

const frames = [];
for (const [screenId, screen] of Object.entries(SCREENS)) {
  for (const locale of LOCALES) {
    const catalog = catalogs[locale];
    const strings = {};
    if (screen.keys) {
      for (const key of screen.keys) {
        strings[key] = catalog[key] ?? "";
      }
    }
    if (screen.docPage) {
      const doc = loadDocTitles(locale, screen.docPage === "hub" ? "hub" : screen.docPage);
      if (doc) {
        strings.docTitle = doc.title;
        strings.docLead = doc.lead;
        strings.docSections = doc.sectionTitles;
      } else if (locale !== "ja" && locale !== "en") {
        const fallback = loadDocTitles("en", screen.docPage === "hub" ? "hub" : screen.docPage);
        if (fallback) {
          strings.docTitle = fallback.title;
          strings.docLead = fallback.lead;
          strings.docSections = fallback.sectionTitles;
          strings._fallback = "en";
        }
      }
    }
    for (const width of [1440, 375]) {
      frames.push({
        id: `${screenId}-${locale}-${width}`,
        screen: screenId,
        locale,
        width,
        path: screen.path,
        strings,
      });
    }
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  issue: 130,
  frameCount: frames.length,
  viewports: [1440, 375],
  locales: LOCALES,
  screens: Object.keys(SCREENS),
  frames,
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${frames.length} frame copy entries to ${path.relative(root, outFile)}`);
