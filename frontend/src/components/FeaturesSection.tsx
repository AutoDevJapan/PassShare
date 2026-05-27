type Feature = {
  title: string;
  description: string;
  badge?: string;
};

const FEATURES: Feature[] = [
  {
    title: "パスワードボックス",
    description: "マスターパスワード1つで開く・閉じる。非 IT 向けに設計されたシンプルな操作感。",
  },
  {
    title: "ローカル暗号化",
    description: "Argon2id + XChaCha20-Poly1305 で端末内に保存。サーバーに平文を送りません。",
  },
  {
    title: "パスワード生成",
    description: "ワンクリックで強力なパスワードを作成。ログイン情報追加時にすぐ使えます。",
  },
  {
    title: "高速検索",
    description: "サイト名・URL・ユーザー名からログイン情報をすぐ見つけられます。",
  },
  {
    title: "ログイン情報管理",
    description: "タイトル・URL・ユーザー名・パスワード・メモの CRUD に対応。",
  },
  {
    title: "緊急キット",
    description: "作成時に表示されるリカバリ用シークレットキーで、万が一の復旧に備えられます。",
  },
  {
    title: "デスクトップアプリ",
    description: "Tauri v2 ベースのネイティブ UI。Web ポータルと同系統のダークテーマ。",
  },
  {
    title: "共有機能",
    description: "PassShare の Share による共有。",
    badge: "Coming soon",
  },
];

export function FeaturesSection() {
  return (
    <section className="landing-section landing-section--alt" id="features" aria-labelledby="features-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">Features</p>
        <h2 className="landing-section__title" id="features-heading">
          MVP で使える機能
        </h2>
        <p className="landing-section__lead">
          非 IT エンジニアが日常使いできるよう、必要な機能に絞って提供します。
        </p>

        <ul className="landing-grid landing-grid--features">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="landing-card">
              <div className="landing-card__header">
                <h3 className="landing-card__title">{feature.title}</h3>
                {feature.badge ? <span className="ps-badge">{feature.badge}</span> : null}
              </div>
              <p className="landing-card__body">{feature.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
