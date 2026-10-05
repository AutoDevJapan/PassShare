import { Link } from "react-router-dom";
import { useI18n } from "../../../shared/i18n/I18nProvider";
import type { MessageKey } from "../../../shared/i18n/index";

type FooterLink = {
  labelKey: MessageKey;
  href: string;
  internal?: boolean;
};

type FooterColumn = {
  titleKey: MessageKey;
  links: FooterLink[];
};

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    titleKey: "footer.product",
    links: [
      { labelKey: "footer.passwordBox", href: "#" },
      { labelKey: "footer.download", href: "/docs/user-guide" },
      { labelKey: "footer.features", href: "#features" },
    ],
  },
  {
    titleKey: "footer.resources",
    links: [
      { labelKey: "footer.documentation", href: "/docs", internal: true },
      { labelKey: "footer.support", href: "/faq", internal: true },
      { labelKey: "footer.faq", href: "/faq", internal: true },
    ],
  },
  {
    titleKey: "footer.legal",
    links: [
      { labelKey: "footer.terms", href: "/terms", internal: true },
      { labelKey: "footer.privacy", href: "/privacy", internal: true },
      { labelKey: "footer.license", href: "https://github.com/AutoDevJapan/PassShare" },
    ],
  },
];

const SOCIAL_LINKS = [
  { label: "GitHub", href: "https://github.com/AutoDevJapan/PassShare" },
  { label: "X", href: "#" },
];

export function Footer() {
  const { t } = useI18n();

  return (
    <footer className="landing-footer">
      <div className="landing-footer__inner">
        <div className="landing-footer__grid">
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.titleKey} className="landing-footer__column">
              <h2 className="landing-footer__heading">{t(column.titleKey)}</h2>
              <ul className="landing-footer__links">
                {column.links.map((link) => (
                  <li key={link.labelKey}>
                    {link.internal ? (
                      <Link to={link.href}>{t(link.labelKey)}</Link>
                    ) : (
                      <a href={link.href} target={link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                        {t(link.labelKey)}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="landing-footer__brand">
            <p className="landing-footer__logo">PassShare</p>
            <p className="landing-footer__tagline">
              {t("footer.tagline.prefix")}
              {t("footer.tagline.box")}
              {t("footer.tagline.suffix")}
            </p>
          </div>
        </div>

        <div className="landing-footer__bottom">
          <p className="landing-footer__copy">
            © {new Date().getFullYear()} PassShare. {t("footer.rights")}
          </p>
          <ul className="landing-footer__social">
            {SOCIAL_LINKS.map((link) => (
              <li key={link.label}>
                <a href={link.href} target={link.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
