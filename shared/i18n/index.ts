import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import ptBR from "./locales/pt-BR.json";
import ru from "./locales/ru.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

/** Must-have locales for v2.0 release */
export const MUST_LOCALES = ["ja", "en", "ru"] as const;

/** Should locales — fall back to en when a key is missing */
export const SHOULD_LOCALES = ["de", "fr", "es", "zh-CN", "zh-TW", "ko", "pt-BR"] as const;

export const UI_LOCALES = [...MUST_LOCALES, ...SHOULD_LOCALES] as const;

export type MustLocale = (typeof MUST_LOCALES)[number];
export type ShouldLocale = (typeof SHOULD_LOCALES)[number];
export type Locale = MustLocale | ShouldLocale;

export type MessageKey = keyof typeof ja;

export const DEFAULT_LOCALE: Locale = "ja";

export const LOCALE_STORAGE_KEY = "passshare.locale";

/** Locales shown in compact button switchers (Must only) */
export const PRIMARY_SWITCHER_LOCALES: MustLocale[] = ["ja", "en", "ru"];

/** Short button labels for dense header toolbars (avoids Cyrillic overflow) */
export const COMPACT_LOCALE_LABELS: Record<MustLocale, string> = {
  ja: "JA",
  en: "EN",
  ru: "RU",
};

/** Label i18n key for each locale in language pickers */
export const LOCALE_LABEL_KEYS: Record<Locale, MessageKey> = {
  ja: "header.lang.ja",
  en: "header.lang.en",
  ru: "header.lang.ru",
  de: "header.lang.de",
  fr: "header.lang.fr",
  es: "header.lang.es",
  "zh-CN": "header.lang.zh-CN",
  "zh-TW": "header.lang.zh-TW",
  ko: "header.lang.ko",
  "pt-BR": "header.lang.pt-BR",
};

const rawCatalogs: Record<Locale, Record<string, string>> = {
  ja,
  en,
  ru,
  de,
  fr,
  es,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ko,
  "pt-BR": ptBR,
};

const FALLBACK_CHAIN: Record<Locale, Locale[]> = {
  ja: [],
  en: ["ja"],
  ru: ["en", "ja"],
  de: ["en", "ja"],
  fr: ["en", "ja"],
  es: ["en", "ja"],
  "zh-CN": ["en", "ja"],
  "zh-TW": ["en", "ja"],
  ko: ["en", "ja"],
  "pt-BR": ["en", "ja"],
};

function mergeWithFallback(locale: Locale): Record<MessageKey, string> {
  const chain = [locale, ...FALLBACK_CHAIN[locale]];
  const merged = {} as Record<MessageKey, string>;
  const baseKeys = Object.keys(ja) as MessageKey[];

  for (const key of baseKeys) {
    for (const candidate of chain) {
      const value = rawCatalogs[candidate][key];
      if (value !== undefined && value !== "") {
        merged[key] = value;
        break;
      }
    }
    if (merged[key] === undefined) {
      merged[key] = key;
    }
  }

  return merged;
}

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  ja: mergeWithFallback("ja"),
  en: mergeWithFallback("en"),
  ru: mergeWithFallback("ru"),
  de: mergeWithFallback("de"),
  fr: mergeWithFallback("fr"),
  es: mergeWithFallback("es"),
  "zh-CN": mergeWithFallback("zh-CN"),
  "zh-TW": mergeWithFallback("zh-TW"),
  ko: mergeWithFallback("ko"),
  "pt-BR": mergeWithFallback("pt-BR"),
};

export function getMessages(locale: Locale): Record<MessageKey, string> {
  return catalogs[locale] ?? catalogs[DEFAULT_LOCALE];
}

export function isLocale(value: string): value is Locale {
  return (UI_LOCALES as readonly string[]).includes(value);
}

const BROWSER_LOCALE_MAP: Array<[RegExp, Locale]> = [
  [/^ja/i, "ja"],
  [/^ru/i, "ru"],
  [/^de/i, "de"],
  [/^fr/i, "fr"],
  [/^es/i, "es"],
  [/^zh-cn/i, "zh-CN"],
  [/^zh-tw/i, "zh-TW"],
  [/^zh/i, "zh-CN"],
  [/^ko/i, "ko"],
  [/^pt/i, "pt-BR"],
  [/^en/i, "en"],
];

export function resolveBrowserLocale(): Locale {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }

  const browser = navigator.language;
  for (const [pattern, locale] of BROWSER_LOCALE_MAP) {
    if (pattern.test(browser)) {
      return locale;
    }
  }

  return "en";
}

export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }

  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && isLocale(stored)) {
    return stored;
  }

  return resolveBrowserLocale();
}

export function applyDocumentLocale(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  }
}

export { formatDate, formatNumber, formatRelativeTime } from "./intl";
export { formatVaultItemCount, formatListItemCount, formatMessage } from "./plural";
export { PSEUDO_LOCALE, buildPseudoCatalog, elongatePseudoString, isPseudoLocale } from "./pseudo";
