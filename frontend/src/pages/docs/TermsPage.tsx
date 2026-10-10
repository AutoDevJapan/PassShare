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
        <p className="doc-article__lead">
          <a href="https://autodevjapan.com/api/disclosure">
            {locale === "ja" ? "事業者情報の開示請求" : locale === "ru" ? "Запрос сведений об операторе" : "Request business information"}
          </a>
          {" · "}
          <a href="mailto:contact@autodevjapan.com">contact@autodevjapan.com</a>
        </p>
      </div>
    </DocPageLayout>
  );
}
