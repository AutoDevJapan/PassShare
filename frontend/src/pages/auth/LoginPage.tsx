import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import { AuthApiError } from "../../lib/auth-api";
import { useAuthSession } from "../../hooks/useAuthSession";

export function LoginPage() {
  const { t } = useI18n();
  const { user, login } = useAuthSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const redirectTo =
    (location.state as { from?: string } | null)?.from ?? "/app/vaults";

  if (user) {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : t("session.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-page__card ps-card">
        <h1 className="ps-heading-2">{t("app.auth.loginTitle")}</h1>
        <form className="ps-grid" onSubmit={(event) => void handleSubmit(event)}>
          <label className="ps-label ps-label--full">
            {t("session.email")}
            <input
              className="ps-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="ps-label ps-label--full">
            {t("session.password")}
            <input
              className="ps-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? (
            <p className="ps-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="ps-button" disabled={submitting}>
            {t("session.login")}
          </button>
        </form>
        <p className="auth-page__links">
          <Link to="/app/signup">{t("app.auth.signupLink")}</Link>
          <Link to="/app/reset-password">{t("app.auth.resetLink")}</Link>
        </p>
      </div>
    </div>
  );
}
