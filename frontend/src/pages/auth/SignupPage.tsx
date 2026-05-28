import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import { AuthApiError } from "../../lib/auth-api";
import { useAuthSession } from "../../hooks/useAuthSession";

export function SignupPage() {
  const { t } = useI18n();
  const { user, signup } = useAuthSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) {
    return <Navigate to="/app/vaults" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signup(email, password);
      navigate("/app/vaults", { replace: true });
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : t("app.auth.signupError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-page__card ps-card">
        <h1 className="ps-heading-2">{t("app.auth.signupTitle")}</h1>
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
              autoComplete="new-password"
              minLength={8}
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
            {t("app.auth.signupSubmit")}
          </button>
        </form>
        <p className="auth-page__links">
          <Link to="/app/login">{t("app.auth.loginLink")}</Link>
        </p>
      </div>
    </div>
  );
}
