import type { Locale } from "./index";

function intlLocale(locale: Locale): string {
  return locale;
}

export function formatDate(
  value: Date | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...options,
  }).format(date);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export function formatRelativeTime(
  value: Date | number,
  locale: Locale,
  base: Date | number = Date.now(),
): string {
  const target = value instanceof Date ? value.getTime() : value;
  const baseMs = base instanceof Date ? base.getTime() : base;
  const diffSeconds = Math.round((target - baseMs) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const sign = diffSeconds < 0 ? -1 : 1;

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];

  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });

  for (const [unit, secondsInUnit] of units) {
    if (absSeconds >= secondsInUnit || unit === "second") {
      const amount = Math.round(absSeconds / secondsInUnit) * sign;
      return formatter.format(amount, unit);
    }
  }

  return formatter.format(0, "second");
}
