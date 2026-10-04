type Row = {
  feature: string;
  passshare: string;
  others: string;
};

const ROWS: Row[] = [
  {
    feature: "端末版の .pbox（マスターパスワード1つ）",
    passshare: "対応",
    others: "ボックスを開く方法とアカウント認証の違い",
  },
  {
    feature: "端末版の .pbox の暗号化",
    passshare: "端末内で暗号化。クラウドはサーバーが内容を読める",
    others: "端末とサーバーで秘密値を読める範囲",
  },
  {
    feature: "パスワード自動生成",
    passshare: "対応",
    others: "使える文字と長さ",
  },
  {
    feature: "使いやすさ",
    passshare: "実際の操作で確認してください",
    others: "体験版で日常の操作を確認",
  },
  {
    feature: "マスターパスワード紛失時の復旧",
    passshare: "緊急キットの値だけでは復旧不可",
    others: "方式と利用条件を確認",
  },
  {
    feature: "共有機能",
    passshare: "Web に実装済み・販売前の検証中",
    others: "招待・本人確認・権限取消の条件",
  },
];

export function ComparisonSection() {
  return (
    <section className="landing-section landing-section--alt" id="comparison" aria-labelledby="comparison-heading">
      <div className="landing-section__inner">
        <p className="landing-section__eyebrow">Comparison</p>
        <h2 className="landing-section__title" id="comparison-heading">
          PassShare の位置づけ
        </h2>
        <p className="landing-section__lead">
          端末版の暗号化とクラウドの保管方式は異なります。クラウドはサーバーが項目の内容を扱う方式です。他社の対応状況は契約するプランの公式説明で確認してください。
        </p>

        <div className="landing-table-wrap">
          <table className="landing-table">
            <thead>
              <tr>
                <th scope="col">機能</th>
                <th scope="col">PassShare</th>
                <th scope="col">契約前に確認すること</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.feature}>
                  <th scope="row">{row.feature}</th>
                  <td>
                    <span className="landing-table__highlight">{row.passshare}</span>
                  </td>
                  <td>{row.others}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
