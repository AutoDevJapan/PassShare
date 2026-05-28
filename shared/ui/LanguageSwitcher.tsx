import {
  COMPACT_LOCALE_LABELS,
  LOCALE_LABEL_KEYS,
  PRIMARY_SWITCHER_LOCALES,
  UI_LOCALES,
  type Locale,
  type MustLocale,
} from "../i18n/index";
import { useI18n } from "../i18n/I18nProvider";

type LanguageSwitcherProps = {
  /** "buttons" for header toolbars; "select" for compact settings panels */
  variant?: "buttons" | "select";
  /** Limit locales (default: Must locales ja/en/ru for buttons, all for select) */
  locales?: readonly Locale[];
  className?: string;
};

function isMustLocale(code: Locale): code is MustLocale {
  return (PRIMARY_SWITCHER_LOCALES as readonly string[]).includes(code);
}

export function LanguageSwitcher({
  variant = "buttons",
  locales,
  className = "",
}: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const options = locales ?? (variant === "select" ? UI_LOCALES : PRIMARY_SWITCHER_LOCALES);

  if (variant === "select") {
    return (
      <label className={`ps-label ps-label--full${className ? ` ${className}` : ""}`}>
        {t("header.lang.label")}
        <select
          className="ps-input"
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {options.map((code) => (
            <option key={code} value={code}>
              {t(LOCALE_LABEL_KEYS[code])}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div
      className={`landing-lang${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={t("header.lang.label")}
    >
      {options.map((code) => (
        <button
          key={code}
          type="button"
          className={`landing-lang__btn${locale === code ? " landing-lang__btn--active" : ""}`}
          aria-pressed={locale === code}
          aria-label={t(LOCALE_LABEL_KEYS[code])}
          onClick={() => setLocale(code)}
        >
          {isMustLocale(code) ? COMPACT_LOCALE_LABELS[code] : t(LOCALE_LABEL_KEYS[code])}
        </button>
      ))}
    </div>
  );
}
