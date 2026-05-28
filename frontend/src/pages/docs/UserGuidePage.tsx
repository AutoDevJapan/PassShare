import { useI18n } from "../../../../shared/i18n/I18nProvider";
import { DocArticle } from "../../components/DocArticle";
import { getDocPage } from "../../content/docs";
import { DocPageLayout } from "../../layouts/DocPageLayout";

export function UserGuidePage() {
  const { locale } = useI18n();
  const content = getDocPage(locale, "userGuide");

  return (
    <DocPageLayout>
      <div className="doc-page__inner">
        <DocArticle content={content} />
      </div>
    </DocPageLayout>
  );
}
