import { useI18n } from "@shared/i18n/I18nProvider";
import { useAuthSession } from "../hooks/useAuthSession";
import { useExtensionLabels } from "../hooks/useExtensionLabels";

export function SettingsPanel() {
  const { locale, setLocale } = useI18n();
  const labels = useExtensionLabels();
  const { logout, user } = useAuthSession();

  return (
    <section className="ext-panel">
      <header className="ext-panel__header">
        <h1 className="ps-heading-2">{labels.settingsTitle}</h1>
        {user ? <p className="ext-panel__lead">{user.email}</p> : null}
      </header>

      <div className="ext-settings ps-card">
        <label className="ps-label ps-label--full">
          Language
          <select
            className="ps-input"
            value={locale}
            onChange={(event) => setLocale(event.target.value as "ja" | "en")}
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </label>

        <p className="ext-muted">{labels.settingsNativeMessaging}</p>

        <button type="button" className="ps-button ps-button--full" onClick={() => void logout()}>
          {labels.settingsLogout}
        </button>
      </div>
    </section>
  );
}
