import { MatrixBackground } from "./MatrixBackground";

export function Hero() {
  return (
    <section className="landing-hero" id="download">
      <MatrixBackground />
      <div className="landing-hero__content">
        <span className="ps-badge">完全無料</span>
        <h1 className="landing-hero__title">
          <span className="landing-hero__title-line">パスワードを、</span>
          <span className="landing-hero__title-line landing-hero__title-line--accent">
            かんたんに安全に。
          </span>
        </h1>
        <p className="ps-lead landing-hero__lead">
          非 IT 向けパスワードマネージャー。マスターパスワード1つで
          <strong> パスワードボックス </strong>
          を開き、ログイン情報を端末内に暗号化して保管します。
        </p>
        <div className="ps-actions landing-hero__actions">
          <a className="ps-button ps-button--primary" href="#download">
            Download
          </a>
          <a className="ps-button ps-button--secondary" href="#docs">
            View Documentation
          </a>
        </div>
      </div>
    </section>
  );
}
