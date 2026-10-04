import { useI18n } from "../../../shared/i18n/I18nProvider";

const STEPS = ["landing.migration.select", "landing.migration.map", "landing.migration.import"] as const;
const SERVICES = ["1Password CSV", "1PUX"];

export function MigrationSection() {
  const { t } = useI18n();
  return (
    <section className="landing-section" id="migration" aria-labelledby="migration-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">{t("landing.migration.eyebrow")}</p>
        <h2 className="landing-section__title" id="migration-heading">{t("landing.migration.title")}</h2>
        <p className="landing-section__lead">{t("landing.migration.lead")}</p>
        <ol className="landing-steps landing-steps--compact">
          {STEPS.map((step, index) => (
            <li key={step} className="landing-steps__item">
              <span className="landing-steps__number">{index + 1}</span>
              <p className="landing-steps__body">{t(step)}</p>
            </li>
          ))}
        </ol>
        <div className="landing-tags" aria-label={t("landing.migration.formats")}>
          {SERVICES.map((service) => <span key={service} className="landing-tags__item">{service}</span>)}
        </div>
      </div>
    </section>
  );
}
