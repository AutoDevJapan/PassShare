import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import { useAuthSession } from "../hooks/useAuthSession";

export function AppShell() {
  const { t } = useI18n();
  const { user, logout } = useAuthSession();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/");
  }

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <Link to="/app/vaults">{t("app.brand")}</Link>
        </div>
        <nav className="app-shell__nav" aria-label={t("app.nav.label")}>
          <NavLink to="/app/vaults" className="app-shell__nav-link">
            {t("app.nav.vaults")}
          </NavLink>
        </nav>
        <div className="app-shell__session">
          <span className="app-shell__email">{user?.email}</span>
          <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleLogout()}>
            {t("session.logout")}
          </button>
        </div>
      </header>

      <main className="app-shell__main">
        <Outlet />
      </main>

      <nav className="app-shell__bottom-nav" aria-label={t("app.nav.mobile")}>
        <NavLink to="/app/vaults" className="app-shell__bottom-link">
          {t("app.nav.vaults")}
        </NavLink>
      </nav>
    </div>
  );
}
