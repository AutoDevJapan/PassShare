import en from "./locales/en.json";
import ja from "./locales/ja.json";

export type Locale = "ja" | "en";

export type MessageKey = keyof typeof ja;

export const DEFAULT_LOCALE: Locale = "ja";

export const LOCALE_STORAGE_KEY = "passshare.locale";

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  ja,
  en,
};

export function getMessages(locale: Locale): Record<MessageKey, string> {
  return catalogs[locale] ?? catalogs[DEFAULT_LOCALE];
}

export function isLocale(value: string): value is Locale {
  return value === "ja" || value === "en";
}

export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }

  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && isLocale(stored)) {
    return stored;
  }

  const browser = window.navigator.language.toLowerCase();
  return browser.startsWith("ja") ? "ja" : "en";
}
