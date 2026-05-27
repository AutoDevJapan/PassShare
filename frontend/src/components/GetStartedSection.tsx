export function GetStartedSection() {
  return (
    <section className="landing-section landing-cta-band" id="get-started" aria-labelledby="get-started-heading">
      <div className="landing-section__inner landing-cta-band__inner">
        <p className="landing-section__eyebrow">Get Started Now</p>
        <h2 className="landing-section__title" id="get-started-heading">
          今すぐ、パスワードボックスを始めよう
        </h2>
        <p className="landing-section__lead">
          完全無料でデスクトップアプリをダウンロード。ドキュメントでセットアップ手順も確認できます。
        </p>
        <div className="ps-actions landing-cta-band__actions">
          <a className="ps-button ps-button--primary" href="#download">
            Free Download
          </a>
          <a className="ps-button ps-button--secondary" href="#docs">
            View Documentation
          </a>
        </div>
      </div>
    </section>
  );
}
