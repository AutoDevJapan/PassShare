import { useState } from "react";

type NavItem = {
  id: string;
  label: string;
  href: string;
  active?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", href: "#", active: true },
  { id: "download", label: "Download", href: "#download" },
  { id: "docs", label: "Docs", href: "#docs" },
];

function LogoMark() {
  return (
    <svg
      className="landing-logo__mark"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="12"
        width="22"
        height="14"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M9 12V9a5 5 0 0 1 10 0v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="14" cy="19" r="2" fill="currentColor" />
    </svg>
  );
}

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="landing-header">
      <div className="landing-header__inner">
        <a className="landing-logo" href="#" aria-label="PassShare ホーム">
          <LogoMark />
          <span>PassShare</span>
        </a>

        <button
          type="button"
          className="landing-header__menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="landing-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="landing-header__menu-icon" aria-hidden="true" />
          <span className="visually-hidden">メニュー</span>
        </button>

        <nav
          id="landing-nav"
          className={`landing-nav${menuOpen ? " landing-nav--open" : ""}`}
          aria-label="メインナビゲーション"
        >
          <ul className="landing-nav__list">
            {NAV_ITEMS.map((item) => (
              <li key={item.id}>
                <a
                  className={`landing-nav__link${item.active ? " landing-nav__link--active" : ""}`}
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="landing-header__tools">
            <label className="landing-search">
              <span className="visually-hidden">検索</span>
              <input type="search" placeholder="Search..." readOnly aria-label="Search" />
              <kbd className="landing-search__kbd">⌘K</kbd>
            </label>

            <div className="landing-lang" role="group" aria-label="言語切替">
              <button type="button" className="landing-lang__btn landing-lang__btn--active">
                日本語
              </button>
              <button type="button" className="landing-lang__btn">
                EN
              </button>
            </div>

            <a className="ps-button ps-button--primary landing-header__cta" href="#download">
              Download
            </a>
          </div>
        </nav>
      </div>
    </header>
  );
}
