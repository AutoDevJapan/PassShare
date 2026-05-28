import { useState, type FormEvent } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";
import { AuthApiError } from "../lib/auth-api";
import { useAuthSession } from "../hooks/useAuthSession";
import { useMobileLabels } from "../hooks/useMobileLabels";

type Mode = "login" | "signup";

export function LoginPanel() {
  const { t } = useI18n();
  const labels = useMobileLabels();
  const { login, signup } = useAuthSession();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await signup(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : t("session.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mobile-panel mobile-panel--auth">
      <header className="mobile-panel__header">
        <h1 className="ps-heading-2">{labels.loginTitle}</h1>
        <p className="mobile-panel__lead">{labels.loginLead}</p>
      </header>

      <form className="mobile-form ps-card" onSubmit={(event) => void handleSubmit(event)}>
        <label className="ps-label ps-label--full">
          {t("session.email")}
          <input
            className="ps-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="ps-label ps-label--full">
          {t("session.password")}
          <input
            className="ps-input"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
          />
        </label>

        {error ? (
          <p className="ps-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="ps-button ps-button--full" disabled={submitting}>
          {mode === "login" ? labels.loginSubmit : labels.signupSubmit}
        </button>
      </form>

      <button
        type="button"
        className="mobile-link-button"
        onClick={() => setMode(mode === "login" ? "signup" : "login")}
      >
        {mode === "login" ? labels.signupSubmit : labels.loginSubmit}
      </button>
    </section>
  );
}
