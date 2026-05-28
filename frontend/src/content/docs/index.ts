import type { Locale } from "../../../../shared/i18n/index";
import { docsEn } from "./en";
import { docsJa } from "./ja";
import type { DocPageContent, DocsHubContent, LocaleDocs } from "./types";

const catalogs: Record<Locale, LocaleDocs> = {
  ja: docsJa,
  en: docsEn,
};

export function getDocsContent(locale: Locale): LocaleDocs {
  return catalogs[locale] ?? catalogs.ja;
}

export function getDocsHub(locale: Locale): DocsHubContent {
  return getDocsContent(locale).hub;
}

export function getDocPage(
  locale: Locale,
  key: keyof Omit<LocaleDocs, "hub">,
): DocPageContent {
  return getDocsContent(locale)[key];
}

export type { DocPageContent, DocsHubContent, DocSection, LegalReviewRow } from "./types";
