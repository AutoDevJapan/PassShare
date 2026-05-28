import { useI18n } from "@shared/i18n/I18nProvider";

export function useExtensionLabels() {
  const { t } = useI18n();

  return {
    appTitle: t("extension.app.title"),
    loginTitle: t("extension.login.title"),
    loginLead: t("extension.login.lead"),
    loginSubmit: t("extension.login.submit"),
    loginSignup: t("extension.login.signup"),
    searchPlaceholder: t("extension.search.placeholder"),
    copyUsername: t("extension.copy.username"),
    copyPassword: t("extension.copy.password"),
    copied: t("extension.copy.done"),
    emptyItems: t("extension.items.empty"),
    settingsTitle: t("extension.settings.title"),
    settingsLogout: t("extension.settings.logout"),
    settingsNativeMessaging: t("extension.settings.nativeMessaging"),
    generatePassword: t("extension.password.generate"),
    navItems: t("extension.nav.items"),
    navSettings: t("extension.nav.settings"),
  };
}
