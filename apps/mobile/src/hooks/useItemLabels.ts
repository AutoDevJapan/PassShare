import { useMemo } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";
import type { ItemUiLabels } from "@shared/types/item.js";

export function useItemLabels(): ItemUiLabels {
  const { t } = useI18n();

  return useMemo(
    () => ({
      categoryLogin: t("item.category.login"),
      categoryPassword: t("item.category.password"),
      categorySecureNote: t("item.category.secureNote"),
      categoryCreditCard: t("item.category.creditCard"),
      categoryIdentity: t("item.category.identity"),
      categorySshKey: t("item.category.sshKey"),
      categoryCustom: t("item.category.custom"),
      fieldTitle: t("item.field.title"),
      fieldUrl: t("item.field.url"),
      fieldUsername: t("item.field.username"),
      fieldPassword: t("item.field.password"),
      fieldBody: t("item.field.body"),
      fieldNotes: t("item.field.notes"),
      fieldTags: t("item.field.tags"),
      fieldFavorite: t("item.field.favorite"),
      addHeading: t("app.item.addHeading"),
      editHeading: t("app.item.editHeading"),
      listHeading: t("app.item.listHeading"),
      searchPlaceholder: t("app.item.searchPlaceholder"),
      generatePassword: t("app.item.generatePassword"),
      submitAdd: t("app.item.submitAdd"),
      submitSave: t("app.item.submitSave"),
      cancelEdit: t("app.item.cancelEdit"),
      copyPassword: t("app.item.copyPassword"),
      copyBody: t("app.item.copyBody"),
      copied: t("app.item.copied"),
      delete: t("app.item.delete"),
      edit: t("app.item.edit"),
      importCsv: t("app.item.importCsv"),
      import1pux: t("app.item.import1pux"),
      exportCsv: t("app.item.exportCsv"),
      importSuccess: t("app.item.importSuccess"),
      import1puxSuccess: t("app.item.import1puxSuccess"),
      exportSuccess: t("app.item.exportSuccess"),
      emptyList: t("app.item.emptyList"),
      lock: t("app.item.lock"),
      countSuffix: t("app.item.countSuffix"),
      confirmDelete: t("app.item.confirmDelete"),
      notSet: t("app.item.notSet"),
    }),
    [t],
  );
}
