import { FormEvent, useState } from "react";
import { useI18n } from "../../../shared/i18n/I18nProvider";
import { useAuthSession } from "../hooks/useAuthSession";

export function SessionControls() {
  const { t } = useI18n();
  const { user, loading, login, logout } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      setPassword("");
    } catch {
      setError(t("session.error"));
    } finally {
      setSubmitting(false);
    }
  }

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
    <form className="landing-session landing-session--form" onSubmit={(event) => void handleSubmit(event)}>
      <label className="landing-session__field">
        <span>{t("session.email")}</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label className="landing-session__field">
        <span>{t("session.password")}</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
        />
      </label>
      {error ? <p className="landing-session__error">{error}</p> : null}
      <button type="submit" className="ps-button ps-button--primary" disabled={submitting}>
        {t("session.login")}
      </button>
    </form>
  );
}
