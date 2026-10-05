import { useI18n } from "../../../shared/i18n/I18nProvider";

const STEPS = [
  ["landing.quick.setup.title", "landing.quick.setup.body"],
  ["landing.quick.create.title", "landing.quick.create.body"],
  ["landing.quick.add.title", "landing.quick.add.body"],
] as const;

export function QuickStartSection() {
  const { t } = useI18n();
  return (
    <section className="landing-section" id="quick-start" aria-labelledby="quick-start-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">{t("landing.quick.eyebrow")}</p>
        <h2 className="landing-section__title" id="quick-start-heading">{t("landing.quick.title")}</h2>
        <p className="landing-section__lead">{t("landing.quick.lead")}</p>
        <ol className="landing-steps">
          {STEPS.map(([title, body], index) => (
            <li key={title} className="landing-steps__item">
              <span className="landing-steps__number">{index + 1}</span>
              <div>
                <h3 className="landing-steps__title">{t(title)}</h3>
                <p className="landing-steps__body">{t(body)}</p>
              </div>
            </li>
          ))}
        </ol>
        <pre className="ps-code-block landing-section__code"><code>{t("landing.quick.example")}</code></pre>
      </div>
    </section>
  );
}
