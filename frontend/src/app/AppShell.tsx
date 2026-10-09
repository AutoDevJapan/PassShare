import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import { LanguageSwitcher } from "@shared/ui/LanguageSwitcher";
import { useAuthSession } from "../hooks/useAuthSession";
import { getApiBaseUrl } from "../lib/auth-api";
import { useLayoutEffect, useRef, useState } from "react";
import { lockCloudUi } from "../lib/cloud-worker";

export function AppShell() {
  const { t, locale } = useI18n();
  const { user, logout } = useAuthSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutPending = useRef(false);
  const generation = useRef(0);
  useLayoutEffect(() => {
    ++generation.current;
    setLogoutFailed(false);
    setLoggingOut(false);
    return () => { ++generation.current; lockCloudUi(); };
  }, [location.key, user?.id]);
  const accountLocale = locale === "en" ? "en" : locale === "ru" ? "ru" : "ja";
  const accountUrl = `${getApiBaseUrl()}/api/auth/password/settings?locale=${accountLocale}`;

  async function handleLogout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setLogoutFailed(false);
    const token = generation.current;
    try { await logout(() => { if (token === generation.current) navigate("/"); }); }
    catch { if (token === generation.current) setLogoutFailed(true); }
    finally {
      logoutPending.current = false;
      if (token === generation.current) setLoggingOut(false);
    }
  }

  return (
    <div className="app-shell" onClickCapture={(event) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) lockCloudUi();
    }}>
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <Link to="/app/vaults">{t("app.brand")}</Link>
        </div>
        <nav className="app-shell__nav" aria-label={t("app.nav.label")}>
          <NavLink to="/app/vaults" className="app-shell__nav-link">
            {t("app.nav.vaults")}
          </NavLink>
          <NavLink to="/app/invitations" className="app-shell__nav-link">
            {t("app.nav.invitations")}
          </NavLink>
          <a href={accountUrl} className="app-shell__nav-link">
            {accountLocale === "ja" ? "アカウント" : accountLocale === "ru" ? "Аккаунт" : "Account"}
          </a>
        </nav>
        <div className="app-shell__session">
          <LanguageSwitcher />
          <span className="app-shell__email">{user?.email}</span>
          <button type="button" className="ps-button ps-button--secondary" disabled={loggingOut} onClick={() => void handleLogout()}>
            {t("session.logout")}
          </button>
        </div>
      </header>

      <main className="app-shell__main">
        {logoutFailed && <p className="ps-error" role="alert">{t("cloud.logoutFailed")}</p>}
        <Outlet />
      </main>

      <nav className="app-shell__bottom-nav" aria-label={t("app.nav.mobile")}>
        <NavLink to="/app/vaults" className="app-shell__bottom-link">
          {t("app.nav.vaults")}
        </NavLink>
        <NavLink to="/app/invitations" className="app-shell__bottom-link">
          {t("app.nav.invitations")}
        </NavLink>
        <a href={accountUrl} className="app-shell__bottom-link">
          {accountLocale === "ja" ? "アカウント" : accountLocale === "ru" ? "Аккаунт" : "Account"}
        </a>
      </nav>
    </div>
  );
}
