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
    description: "端末版の .pbox は Argon2id + XChaCha20-Poly1305 で暗号化します。クラウドを利用すると、項目の内容はサーバーにも送られます。",
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
    title: "バックアップと復旧",
    description: "端末版は .pbox のコピーとマスターパスワードを保管してください。現在、緊急キットの値だけで開く機能はありません。",
  },
  {
    title: "デスクトップアプリ",
    description: "Tauri v2 ベースのネイティブ UI。Web ポータルと同系統のダークテーマ。",
  },
  {
    title: "共有機能",
    description: "Web でチームを招待して共有できます。本人確認とクラウド暗号化の改善を進めています。販売前の検証対象です。",
    badge: "検証中",
  },
];

export function FeaturesSection() {
  return (
    <section className="landing-section landing-section--alt" id="features" aria-labelledby="features-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">Features</p>
        <h2 className="landing-section__title" id="features-heading">
          実装済みの機能と利用条件
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
