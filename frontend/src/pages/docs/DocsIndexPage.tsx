import { Link } from "react-router-dom";
import { useI18n } from "../../../../shared/i18n/I18nProvider";
import { getDocsHub } from "../../content/docs";
import { DocPageLayout } from "../../layouts/DocPageLayout";

export function DocsIndexPage() {
  const { locale } = useI18n();
  const hub = getDocsHub(locale);

  return (
    <DocPageLayout>
      <div className="doc-page__inner">
        <header className="doc-hub__header">
          <h1>{hub.title}</h1>
          <p>{hub.lead}</p>
        </header>
        <ul className="doc-hub__list">
          {hub.links.map((link) => (
            <li key={link.path}>
              <Link to={link.path} className="doc-hub__card">
                <span className="doc-hub__card-title">{link.title}</span>
                <span className="doc-hub__card-desc">{link.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </DocPageLayout>
  );
}
