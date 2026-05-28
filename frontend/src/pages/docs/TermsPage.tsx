import { useI18n } from "../../../../shared/i18n/I18nProvider";
import { DocArticle } from "../../components/DocArticle";
import { getDocPage } from "../../content/docs";
import { DocPageLayout } from "../../layouts/DocPageLayout";

export function TermsPage() {
  const { locale } = useI18n();
  const content = getDocPage(locale, "terms");

  return (
    <DocPageLayout>
      <div className="doc-page__inner">
        <DocArticle content={content} backLabel={locale === "ja" ? "← ドキュメント" : "← Documentation"} />
      </div>
    </DocPageLayout>
  );
}
