import { useI18n } from "../../../shared/i18n/I18nProvider";

export function GetStartedSection() {
  const { t } = useI18n();

  return (
    <section className="landing-section landing-cta-band" id="get-started" aria-labelledby="get-started-heading">
      <div className="landing-section__inner landing-cta-band__inner">
        <p className="landing-section__eyebrow">{t("landing.start.eyebrow")}</p>
        <h2 className="landing-section__title" id="get-started-heading">
          {t("landing.start.title")}
        </h2>
        <p className="landing-section__lead">
          {t("landing.start.lead")}
        </p>
        <div className="ps-actions landing-cta-band__actions">
          <a className="ps-button ps-button--primary" href="/docs">
            {t("hero.cta.docs")}
          </a>
          <a className="ps-button ps-button--secondary" href="/docs/user-guide">
            {t("hero.cta.download")}
          </a>
        </div>
      </div>
    </section>
  );
}
