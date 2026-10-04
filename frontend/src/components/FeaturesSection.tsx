import { useI18n } from "../../../shared/i18n/I18nProvider";

const FEATURES = [
  ["landing.features.box.title", "landing.features.box.body"],
  ["landing.features.crypto.title", "landing.features.crypto.body"],
  ["landing.features.generate.title", "landing.features.generate.body"],
  ["landing.features.search.title", "landing.features.search.body"],
  ["landing.features.manage.title", "landing.features.manage.body"],
  ["landing.features.backup.title", "landing.features.backup.body"],
  ["landing.features.desktop.title", "landing.features.desktop.body"],
  ["landing.features.share.title", "landing.features.share.body"],
] as const;

export function FeaturesSection() {
  const { t } = useI18n();
  return (
    <section className="landing-section landing-section--alt" id="features" aria-labelledby="features-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">{t("landing.features.eyebrow")}</p>
        <h2 className="landing-section__title" id="features-heading">{t("landing.features.title")}</h2>
        <p className="landing-section__lead">{t("landing.features.lead")}</p>
        <ul className="landing-grid landing-grid--features">
          {FEATURES.map(([title, body]) => (
            <li key={title} className="landing-card">
              <div className="landing-card__header">
                <h3 className="landing-card__title">{t(title)}</h3>
                {title === "landing.features.share.title" ? <span className="ps-badge">{t("landing.features.share.badge")}</span> : null}
              </div>
              <p className="landing-card__body">{t(body)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
