import type { Locale } from "./index";

type ItemCountForms = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};

const VAULT_ITEM_FORMS: Record<Locale, ItemCountForms> = {
  ja: { other: "{count} 件" },
  en: { one: "{count} item", other: "{count} items" },
  ru: {
    one: "{count} элемент",
    few: "{count} элемента",
    many: "{count} элементов",
    other: "{count} элементов",
  },
  de: { one: "{count} Element", other: "{count} Elemente" },
  fr: { one: "{count} élément", other: "{count} éléments" },
  es: { one: "{count} elemento", other: "{count} elementos" },
  "zh-CN": { other: "{count} 项" },
  "zh-TW": { other: "{count} 項" },
  ko: { other: "{count}개" },
  "pt-BR": { one: "{count} item", other: "{count} itens" },
};

const LIST_ITEM_FORMS: Record<Locale, ItemCountForms> = {
  ja: { other: "{count}件" },
  en: { one: "{count} item", other: "{count} items" },
  ru: {
    one: "{count} элемент",
    few: "{count} элемента",
    many: "{count} элементов",
    other: "{count} элементов",
  },
  de: { one: "{count} Element", other: "{count} Elemente" },
  fr: { one: "{count} élément", other: "{count} éléments" },
  es: { one: "{count} elemento", other: "{count} elementos" },
  "zh-CN": { other: "{count}项" },
  "zh-TW": { other: "{count}項" },
  ko: { other: "{count}개" },
  "pt-BR": { one: "{count} item", other: "{count} itens" },
};

function selectForm(count: number, locale: Locale, forms: ItemCountForms): string {
  const rules = new Intl.PluralRules(locale);
  const category = rules.select(count) as keyof ItemCountForms;
  const template = forms[category] ?? forms.other;
  return template.replace("{count}", String(count));
}

export function formatVaultItemCount(count: number, locale: Locale): string {
  return selectForm(count, locale, VAULT_ITEM_FORMS[locale] ?? VAULT_ITEM_FORMS.en);
}

export function formatListItemCount(count: number, locale: Locale): string {
  return selectForm(count, locale, LIST_ITEM_FORMS[locale] ?? LIST_ITEM_FORMS.en);
}

/**
 * Simple ICU-style placeholder replacement for sync messages.
 * Supports {name} tokens only; plural rules use formatVaultItemCount / formatListItemCount.
 */
export function formatMessage(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    return value === undefined ? `{${key}}` : String(value);
  });
}
