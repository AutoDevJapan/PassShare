import { useI18n } from "../../../../shared/i18n/I18nProvider";
import { LanguageSwitcher } from "../../../../shared/ui/LanguageSwitcher";

export function AppHeader() {
  const { t } = useI18n();

  return (
    <header className="ps-app__header">
      <div className="ps-app__brand">
        <span className="ps-badge">{t("desktop.badge")}</span>
        <p className="ps-eyebrow">{t("desktop.eyebrow")}</p>
        <LanguageSwitcher className="ps-app__lang" />
      </div>
      <h1 className="ps-heading-2">{t("desktop.title")}</h1>
      <p className="ps-lead">{t("desktop.lead")}</p>
    </header>
  );
}
