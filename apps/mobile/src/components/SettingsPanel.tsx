import { useI18n } from "@shared/i18n/I18nProvider";
import { LanguageSwitcher } from "@shared/ui/LanguageSwitcher";
import { clearAppPin } from "../lib/app-lock";
import {
  IDLE_TIMEOUT_OPTIONS_MS,
  getAutoLockIdleMs,
  setAutoLockIdleMs,
} from "../lib/auto-lock";
import { isBiometricAvailable, isSecureStorageAvailable } from "../lib/secure-storage";
import { useAuthSession } from "../hooks/useAuthSession";
import { useMobileLabels } from "../hooks/useMobileLabels";
import { useEffect, useState } from "react";

export function SettingsPanel() {
  const { t } = useI18n();
  const labels = useMobileLabels();
  const { user, logout } = useAuthSession();
  const [biometric, setBiometric] = useState(false);
  const [secureStorage, setSecureStorage] = useState(true);
  const [idleMs, setIdleMs] = useState(() => getAutoLockIdleMs());

  const idleLabels: Record<number, string> = {
    60_000: labels.autoLockIdle1m,
    120_000: labels.autoLockIdle2m,
    300_000: labels.autoLockIdle5m,
  };

  function handleIdleChange(value: number) {
    setIdleMs(value);
    setAutoLockIdleMs(value);
  }

  useEffect(() => {
    void isBiometricAvailable().then(setBiometric);
    void isSecureStorageAvailable().then(setSecureStorage);
  }, []);

  async function handleLogout() {
    await clearAppPin();
    await logout();
  }

  return (
    <section className="mobile-panel">
      <header className="mobile-panel__header">
        <h1 className="ps-heading-2">{labels.settingsTitle}</h1>
        {user ? (
          <p className="mobile-panel__lead">
            {t("session.signedInAs")}: {user.email}
          </p>
        ) : null}
      </header>

      <div className="mobile-settings ps-card">
        <LanguageSwitcher variant="select" />
        <p>
          {labels.settingsBiometric}: {biometric ? "✓" : "—"}
        </p>
        <p>
          {labels.settingsSecureStorage}: {secureStorage ? "✓" : "—"}
        </p>
        {secureStorage ? null : (
          <p className="ps-error" role="alert">
            {labels.settingsSecureStorageUnavailable}
          </p>
        )}
        <p className="mobile-settings__section">{labels.settingsAutoLock}</p>
        <label className="ps-label ps-label--full">
          {labels.settingsAutoLockIdle}
          <select
            className="ps-input"
            value={idleMs}
            onChange={(event) => handleIdleChange(Number(event.target.value))}
          >
            {IDLE_TIMEOUT_OPTIONS_MS.map((option) => (
              <option key={option} value={option}>
                {idleLabels[option] ?? option}
              </option>
            ))}
          </select>
        </label>
        <p className="mobile-settings__hint">{labels.settingsAutoLockHint}</p>
        <p className="mobile-settings__stub">{labels.autofillStub}</p>
        <p className="mobile-settings__stub">{labels.shareStub}</p>
        <button type="button" className="ps-button ps-button--full" onClick={() => void handleLogout()}>
          {labels.settingsLogout}
        </button>
      </div>
    </section>
  );
}
