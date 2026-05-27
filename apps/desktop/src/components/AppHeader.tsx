import { useI18n } from "../../../../shared/i18n/I18nProvider";

export function AppHeader() {
  const { locale, setLocale, t } = useI18n();

  return (
    <header className="ps-app__header">
      <div className="ps-app__brand">
        <span className="ps-badge">{t("desktop.badge")}</span>
        <p className="ps-eyebrow">{t("desktop.eyebrow")}</p>
        <div className="landing-lang ps-app__lang" role="group" aria-label={t("header.lang.label")}>
          <button
            type="button"
            className={`landing-lang__btn${locale === "ja" ? " landing-lang__btn--active" : ""}`}
            aria-pressed={locale === "ja"}
            onClick={() => setLocale("ja")}
          >
            {t("header.lang.ja")}
          </button>
          <button
            type="button"
            className={`landing-lang__btn${locale === "en" ? " landing-lang__btn--active" : ""}`}
            aria-pressed={locale === "en"}
            onClick={() => setLocale("en")}
          >
            {t("header.lang.en")}
          </button>
        </div>
      </div>
      <h1 className="ps-heading-2">{t("desktop.title")}</h1>
      <p className="ps-lead">{t("desktop.lead")}</p>
    </header>
  );
}
