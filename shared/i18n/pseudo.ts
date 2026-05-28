import type { MessageKey } from "./index";

/** Pseudo-locale for layout stress testing (Microsoft qps-ploc style elongation). */
export const PSEUDO_LOCALE = "qps-ploc" as const;

export type PseudoLocale = typeof PSEUDO_LOCALE;

export function isPseudoLocale(value: string): value is PseudoLocale {
  return value === PSEUDO_LOCALE;
}

/** Wrap each character to simulate ~30% longer UI strings. */
export function elongatePseudoString(value: string): string {
  return `[${value.split("").join("][")}]`;
}

export function buildPseudoCatalog(base: Record<MessageKey, string>): Record<MessageKey, string> {
  const result = {} as Record<MessageKey, string>;
  for (const key of Object.keys(base) as MessageKey[]) {
    result[key] = elongatePseudoString(base[key]);
  }
  return result;
}
