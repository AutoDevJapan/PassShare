const STEPS = [
  "1Password 形式の CSV または 1PUX を選択",
  "PassShare がフィールドをマッピング",
  "パスワードボックスにインポート完了",
];

const SERVICES = ["1Password CSV", "1PUX"];

export function MigrationSection() {
  return (
    <section className="landing-section" id="migration" aria-labelledby="migration-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">Easy Migration</p>
        <h2 className="landing-section__title" id="migration-heading">
          かんたん移行
        </h2>
        <p className="landing-section__lead">
          Web とデスクトップで 1Password 形式の CSV を取り込めます。Web とデスクトップのクラウド連携では 1PUX も取り込めます。他社の独自形式は対象外です。移行ファイルには秘密値が含まれるため、取込後は安全に扱ってください。
        </p>

        <ol className="landing-steps landing-steps--compact">
          {STEPS.map((step, index) => (
            <li key={step} className="landing-steps__item">
              <span className="landing-steps__number">{index + 1}</span>
              <p className="landing-steps__body">{step}</p>
            </li>
          ))}
        </ol>

        <div className="landing-tags" aria-label="対応する形式">
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
