type FooterColumn = {
  title: string;
  links: { label: string; href: string }[];
};

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { label: "パスワードボックス", href: "#" },
      { label: "ダウンロード", href: "#download" },
      { label: "機能一覧", href: "#features" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "ドキュメント", href: "#docs" },
      { label: "サポート", href: "#" },
      { label: "よくある質問", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "利用規約", href: "#" },
      { label: "プライバシーポリシー", href: "#" },
      { label: "ライセンス", href: "#" },
    ],
  },
];

const SOCIAL_LINKS = [
  { label: "GitHub", href: "https://github.com/AutoDevJapan/PassShare" },
  { label: "X", href: "#" },
];

export function Footer() {
  return (
    <footer className="landing-footer" id="docs">
      <div className="landing-footer__inner">
        <div className="landing-footer__grid">
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.title} className="landing-footer__column">
              <h2 className="landing-footer__heading">{column.title}</h2>
              <ul className="landing-footer__links">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="landing-footer__brand">
            <p className="landing-footer__logo">PassShare</p>
            <p className="landing-footer__tagline">
              非 IT 向けパスワードマネージャー。Tauri デスクトップアプリと Web ポータルで、
              パスワードボックスをどこからでも扱えます。
            </p>
          </div>
        </div>

        <div className="landing-footer__bottom">
          <p className="landing-footer__copy">© {new Date().getFullYear()} PassShare. All rights reserved.</p>
          <ul className="landing-footer__social">
            {SOCIAL_LINKS.map((link) => (
              <li key={link.label}>
                <a href={link.href} target={link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
