import { useI18n } from "../../../shared/i18n/I18nProvider";

const ROWS = [
  ["landing.compare.box.feature", "landing.compare.supported", "landing.compare.box.check"],
  ["landing.compare.crypto.feature", "landing.compare.crypto.value", "landing.compare.crypto.check"],
  ["landing.compare.generate.feature", "landing.compare.supported", "landing.compare.generate.check"],
  ["landing.compare.ease.feature", "landing.compare.ease.value", "landing.compare.ease.check"],
  ["landing.compare.recovery.feature", "landing.compare.recovery.value", "landing.compare.recovery.check"],
  ["landing.compare.share.feature", "landing.compare.share.value", "landing.compare.share.check"],
] as const;

export function ComparisonSection() {
  const { t } = useI18n();
  return (
    <section className="landing-section landing-section--alt" id="comparison" aria-labelledby="comparison-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">{t("landing.compare.eyebrow")}</p>
        <h2 className="landing-section__title" id="comparison-heading">{t("landing.compare.title")}</h2>
        <p className="landing-section__lead">{t("landing.compare.lead")}</p>
        <div className="landing-table-wrap">
          <table className="landing-table">
            <thead><tr>
              <th scope="col">{t("landing.compare.feature")}</th>
              <th scope="col">PassShare</th>
              <th scope="col">{t("landing.compare.check")}</th>
            </tr></thead>
            <tbody>
              {ROWS.map(([feature, value, check]) => (
                <tr key={feature}>
                  <th scope="row">{t(feature)}</th>
                  <td><span className="landing-table__highlight">{t(value)}</span></td>
                  <td>{t(check)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
