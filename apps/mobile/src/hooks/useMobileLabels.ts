import { useMemo } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";

export function useMobileLabels() {
  const { t } = useI18n();

  return useMemo(
    () => ({
      appTitle: t("mobile.app.title"),
      loginTitle: t("mobile.login.title"),
      loginLead: t("mobile.login.lead"),
      signupSubmit: t("mobile.login.signup"),
      loginSubmit: t("mobile.login.submit"),
      vaultTab: t("mobile.nav.vaults"),
      settingsTab: t("mobile.nav.settings"),
      lockTitle: t("mobile.lock.title"),
      lockLead: t("mobile.lock.lead"),
      lockBiometric: t("mobile.lock.biometric"),
      lockPin: t("mobile.lock.pin"),
      lockPinPlaceholder: t("mobile.lock.pinPlaceholder"),
      lockUnlock: t("mobile.lock.unlock"),
      lockSetupPin: t("mobile.lock.setupPin"),
      lockSetupPinConfirm: t("mobile.lock.setupPinConfirm"),
      lockPinMismatch: t("mobile.lock.pinMismatch"),
      settingsTitle: t("mobile.settings.title"),
      settingsBiometric: t("mobile.settings.biometric"),
      settingsLogout: t("mobile.settings.logout"),
      shareStub: t("mobile.share.stub"),
      autofillStub: t("mobile.autofill.stub"),
    }),
    [t],
  );
}
