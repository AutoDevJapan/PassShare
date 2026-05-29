import { Link } from "react-router-dom";
import { useI18n } from "../../../shared/i18n/I18nProvider";
import { useAuthSession } from "../hooks/useAuthSession";

export function SessionControls() {
  const { t } = useI18n();
  const { user, loading, logout } = useAuthSession();

  if (loading) {
    return <p className="landing-session__status">{t("session.loading")}</p>;
  }

  if (user) {
    return (
      <div className="landing-session">
        <p className="landing-session__status">
          {t("session.signedInAs")} <strong>{user.email}</strong>
        </p>
        <button type="button" className="ps-button ps-button--ghost" onClick={() => void logout()}>
          {t("session.logout")}
        </button>
      </div>
    );
  }

  return (
    <Link className="ps-button ps-button--ghost landing-session__login" to="/app/login">
      {t("session.login")}
    </Link>
  );
}
