import { Link } from "react-router-dom";
import { useCallback, useState } from "react";
import { useI18n } from "../../../shared/i18n/I18nProvider";
import { LanguageSwitcher } from "../../../shared/ui/LanguageSwitcher";
import { isApplePlatform, useSearchShortcut } from "../hooks/useSearchShortcut";
import { SearchDialog } from "./SearchDialog";
import { SessionControls } from "./SessionControls";

type NavItem = {
  id: string;
  labelKey: "header.nav.home" | "header.nav.download" | "header.nav.docs" | "header.nav.app";
  href: string;
  active?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home", labelKey: "header.nav.home", href: "#", active: true },
  { id: "app", labelKey: "header.nav.app", href: "/app/vaults" },
  { id: "download", labelKey: "header.nav.download", href: "/docs/user-guide" },
  { id: "docs", labelKey: "header.nav.docs", href: "/docs" },
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
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const openSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  useSearchShortcut(openSearch);

  const shortcutLabel = isApplePlatform()
    ? t("header.search.shortcutMac")
    : t("header.search.shortcutWin");

  return (
    <>
      <header className="landing-header">
        <div className="landing-header__inner">
          <Link className="landing-logo" to="/" aria-label={t("header.logoAria")}>
            <LogoMark />
            <span>PassShare</span>
          </Link>

          <button
            type="button"
            className="landing-header__menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="landing-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="landing-header__menu-icon" aria-hidden="true" />
            <span className="visually-hidden">{t("header.menu")}</span>
          </button>

          <nav
            id="landing-nav"
            className={`landing-nav${menuOpen ? " landing-nav--open" : ""}`}
            aria-label={t("header.nav.label")}
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
                    {t(item.labelKey)}
                  </a>
                </li>
              ))}
            </ul>

            <div className="landing-header__tools">
              <button
                type="button"
                className="landing-search"
                aria-haspopup="dialog"
                aria-expanded={searchOpen}
                onClick={openSearch}
              >
                <span className="visually-hidden">{t("header.search.label")}</span>
                <span className="landing-search__label">{t("header.search.placeholder")}</span>
                <kbd className="landing-search__kbd">{shortcutLabel}</kbd>
              </button>

              <LanguageSwitcher />

              <SessionControls />
            </div>
          </nav>
        </div>
      </header>

      <SearchDialog
        open={searchOpen}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onClose={closeSearch}
      />
    </>
  );
}
