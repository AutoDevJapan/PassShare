import { MatrixBackground } from "../../../shared/ui/MatrixBackground";
import { useI18n } from "../../../shared/i18n/I18nProvider";

export function Hero() {
  const { t } = useI18n();

  return (
    <section className="landing-hero" id="download">
      <MatrixBackground />
      <div className="landing-hero__content">
        <span className="ps-badge">{t("hero.badge")}</span>
        <h1 className="landing-hero__title">
          <span className="landing-hero__title-line">{t("hero.title.line1")}</span>
          <span className="landing-hero__title-line landing-hero__title-line--accent">
            {t("hero.title.line2")}
          </span>
        </h1>
        <p className="ps-lead landing-hero__lead">
          {t("hero.lead.prefix")}
          <strong> {t("hero.lead.box")} </strong>
          {t("hero.lead.suffix")}
        </p>
        <div className="ps-actions landing-hero__actions">
          <a className="ps-button ps-button--primary" href="#download">
            {t("hero.cta.download")}
          </a>
          <a className="ps-button ps-button--secondary" href="#docs">
            {t("hero.cta.docs")}
          </a>
        </div>
      </div>
    </section>
  );
}
