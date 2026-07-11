import { useMemo } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";

export function useDesktopLabels() {
  const { t } = useI18n();

  return useMemo(
    () => ({
      setup: {
        title: t("desktop.setup.title"),
        lead: t("desktop.setup.lead"),
        pathLabel: t("desktop.setup.pathLabel"),
        pathPlaceholder: t("desktop.setup.pathPlaceholder"),
        masterPassword: t("desktop.setup.masterPassword"),
        create: t("desktop.setup.create"),
        open: t("desktop.setup.open"),
        biometricOpen: t("desktop.setup.biometricOpen"),
        errorPathRequired: t("desktop.setup.error.pathRequired"),
        errorPasswordRequired: t("desktop.setup.error.passwordRequired"),
        successCreated: t("desktop.setup.success.created"),
        successOpened: t("desktop.setup.success.opened"),
        successBiometricOpened: t("desktop.setup.success.biometricOpened"),
      },
      recovery: {
        badge: t("desktop.recovery.badge"),
        title: t("desktop.recovery.title"),
        lead: t("desktop.recovery.lead"),
        copy: t("desktop.recovery.copy"),
        confirm: t("desktop.recovery.confirm"),
        copied: t("app.item.copied"),
      },
      biometric: {
        title: t("desktop.biometric.title"),
        lead: t("desktop.biometric.lead"),
        enable: t("desktop.biometric.enable"),
        disable: t("desktop.biometric.disable"),
        errorLocked: t("desktop.biometric.error.locked"),
        successEnabled: t("desktop.biometric.success.enabled"),
        successDisabled: t("desktop.biometric.success.disabled"),
        errorEnable: t("desktop.biometric.error.enable"),
        errorDisable: t("desktop.biometric.error.disable"),
      },
      clipboard: {
        heading: t("desktop.clipboard.heading"),
        description: t("desktop.clipboard.description"),
        secondsLabel: t("desktop.clipboard.secondsLabel"),
        secondsSuffix: t("desktop.clipboard.secondsSuffix"),
        save: t("desktop.clipboard.save"),
        saved: t("desktop.clipboard.saved"),
      },
      sync: {
        title: t("desktop.sync.title"),
        lead: t("desktop.sync.lead"),
        enable: t("desktop.sync.enable"),
        apiUrl: t("desktop.sync.apiUrl"),
        email: t("desktop.sync.email"),
        password: t("desktop.sync.password"),
        vaultId: t("desktop.sync.vaultId"),
        run: t("desktop.sync.run"),
        runSync: t("desktop.sync.runSync"),
        syncSuccess: (pushed: number, pulled: number) =>
          t("desktop.sync.syncSuccess").replace("{pushed}", String(pushed)).replace("{pulled}", String(pulled)),
        syncPartial: (pushed: number, pulled: number, failed: number) =>
          t("desktop.sync.syncPartial")
            .replace("{pushed}", String(pushed))
            .replace("{pulled}", String(pulled))
            .replace("{failed}", String(failed)),
        progress: (completed: number, total: number) =>
          t("desktop.sync.progress").replace("{completed}", String(completed)).replace("{total}", String(total)),
        failedItemsTitle: t("desktop.sync.failedItemsTitle"),
        failedItem: (title: string) => t("desktop.sync.failedItem").replace("{title}", title),
        keepLocal: t("desktop.sync.keepLocal"),
        keepRemote: t("desktop.sync.keepRemote"),
        import1pux: t("desktop.sync.import1pux"),
        conflictTitle: t("desktop.sync.conflictTitle"),
        conflictItem: (title: string) => t("desktop.sync.conflictItem").replace("{title}", title),
        noConflict: t("desktop.sync.noConflict"),
        error: t("desktop.sync.error"),
        errorAuth: t("desktop.sync.error.auth"),
        errorNetwork: t("desktop.sync.error.network"),
        errorServer: t("desktop.sync.error.server"),
      },
      loading: t("desktop.loading"),
      mainHiddenTitle: t("desktop.main.hiddenTitle"),
      categoryPicker: t("desktop.categoryPicker"),
    }),
    [t],
  );
}
