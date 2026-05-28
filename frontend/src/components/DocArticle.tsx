import { Link } from "react-router-dom";
import { useI18n } from "../../../shared/i18n/I18nProvider";
import type { DocPageContent } from "../content/docs";

type DocArticleProps = {
  content: DocPageContent;
  backHref?: string;
  backLabel?: string;
};

export function DocArticle({ content, backHref = "/docs", backLabel }: DocArticleProps) {
  const { locale } = useI18n();
  const resolvedBackLabel = backLabel ?? (locale === "ja" ? "← ドキュメント" : "← Documentation");
  const reviewHeading = locale === "ja" ? "法務レビュー" : "Legal review";

  return (
    <article className="doc-article">
      <p className="doc-article__back">
        <Link to={backHref}>{resolvedBackLabel}</Link>
      </p>
      <header className="doc-article__header">
        <h1>{content.title}</h1>
        {content.lead ? <p className="doc-article__lead">{content.lead}</p> : null}
      </header>

      {content.sections.map((section) => (
        <section key={section.id} id={section.id} className="doc-article__section">
          <h2>{section.title}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.list ? (
            <ul>
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      {content.legalReview ? (
        <section className="doc-article__review" aria-labelledby="legal-review-heading">
          <h2 id="legal-review-heading">{reviewHeading}</h2>
          <table className="doc-article__table">
            <tbody>
              {content.legalReview.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </article>
  );
}
