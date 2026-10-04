const STEPS = [
  {
    title: "導入手順を確認",
    body: "ユーザーガイドで、端末で保管する版とクラウド版の違い、対応する導入方法を確認します。",
  },
  {
    title: "パスワードボックスを新規作成",
    body: "端末版では保存先とマスターパスワードを決めて「新規作成」を押します。現在、緊急キットの値だけでは復旧できません。マスターパスワードとファイルのバックアップを保管してください。",
  },
  {
    title: "ログイン情報を追加",
    body: "パスワードボックスを開いたら、サイト名・URL・ユーザー名・パスワードを登録して利用を開始します。",
  },
];

export function QuickStartSection() {
  return (
    <section className="landing-section" id="quick-start" aria-labelledby="quick-start-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">Quick Start</p>
        <h2 className="landing-section__title" id="quick-start-heading">
          3 ステップで始める
        </h2>
        <p className="landing-section__lead">
          ブラウザではなくデスクトップアプリから、マスターパスワード1つで
          <strong> パスワードボックス </strong>
          を操作します。
        </p>

        <ol className="landing-steps">
          {STEPS.map((step, index) => (
            <li key={step.title} className="landing-steps__item">
              <span className="landing-steps__number">{index + 1}</span>
              <div>
                <h3 className="landing-steps__title">{step.title}</h3>
                <p className="landing-steps__body">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <pre className="ps-code-block landing-section__code">
          <code>{`# 1. デスクトップアプリを起動
# 2. ファイルの場所（例）
C:\\Users\\あなた\\Documents\\mypasswords.pbox

# 3. マスターパスワードを設定して「新規作成」
# 4. ログイン情報を追加して検索・生成機能を使う`}</code>
        </pre>
      </div>
    </section>
  );
}
