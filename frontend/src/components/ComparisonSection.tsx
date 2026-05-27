type Row = {
  feature: string;
  passshare: string;
  others: string;
};

const ROWS: Row[] = [
  {
    feature: "パスワードボックス（マスターパスワード1つ）",
    passshare: "対応",
    others: "各社対応",
  },
  {
    feature: "ローカル暗号化（ゼロナレッジ）",
    passshare: "対応",
    others: "プランによる",
  },
  {
    feature: "パスワード自動生成",
    passshare: "対応",
    others: "対応",
  },
  {
    feature: "非 IT 向け UI",
    passshare: "最優先",
    others: "限定的",
  },
  {
    feature: "緊急キット（リカバリ）",
    passshare: "対応",
    others: "各社異なる",
  },
  {
    feature: "共有機能",
    passshare: "v0.2 予定",
    others: "有料プラン中心",
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
          MVP 機能に絞った比較です。個人利用・非 IT 向けのシンプルさを重視しています。
        </p>

        <div className="landing-table-wrap">
          <table className="landing-table">
            <thead>
              <tr>
                <th scope="col">機能</th>
                <th scope="col">PassShare</th>
                <th scope="col">主要 PM 一般</th>
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
