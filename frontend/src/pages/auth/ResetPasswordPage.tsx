import { Link } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";

export function ResetPasswordPage() {
  const { t } = useI18n();

  return (
    <div className="auth-page">
      <div className="auth-page__card ps-card">
        <h1 className="ps-heading-2">{t("app.auth.resetTitle")}</h1>
        <p>{t("app.auth.resetDescription")}</p>
        <p className="auth-page__links">
          <Link to="/app/login">{t("app.auth.loginLink")}</Link>
        </p>
      </div>
    </div>
  );
}
