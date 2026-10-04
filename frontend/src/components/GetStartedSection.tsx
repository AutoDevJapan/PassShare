import { useI18n } from "../../../shared/i18n/I18nProvider";

export function GetStartedSection() {
  const { t } = useI18n();

  return (
    <section className="landing-section landing-cta-band" id="get-started" aria-labelledby="get-started-heading">
      <div className="landing-section__inner landing-cta-band__inner">
        <p className="landing-section__eyebrow">Get Started Now</p>
        <h2 className="landing-section__title" id="get-started-heading">
          今すぐ、パスワードボックスを始めよう
        </h2>
        <p className="landing-section__lead">
          端末で保管する版とクラウド版の違いを確認してから、導入手順へ進んでください。
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
