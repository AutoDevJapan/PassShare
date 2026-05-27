const STEPS = [
  "他サービスからエクスポートした CSV / JSON を選択",
  "PassShare がフィールドをマッピング",
  "パスワードボックスにインポート完了",
];

const SERVICES = ["1Password", "LastPass", "Bitwarden", "KeePass", "Chrome", "Firefox"];

export function MigrationSection() {
  return (
    <section className="landing-section" id="migration" aria-labelledby="migration-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">Easy Migration</p>
        <h2 className="landing-section__title" id="migration-heading">
          かんたん移行
          <span className="ps-badge landing-section__badge">Coming soon</span>
        </h2>
        <p className="landing-section__lead">
          既存のパスワードマネージャーから PassShare へ移行する機能は v0.2 以降で提供予定です。
        </p>

        <ol className="landing-steps landing-steps--compact">
          {STEPS.map((step, index) => (
            <li key={step} className="landing-steps__item">
              <span className="landing-steps__number">{index + 1}</span>
              <p className="landing-steps__body">{step}</p>
            </li>
          ))}
        </ol>

        <div className="landing-tags" aria-label="対応予定サービス">
          {SERVICES.map((service) => (
            <span key={service} className="landing-tags__item">
              {service}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
