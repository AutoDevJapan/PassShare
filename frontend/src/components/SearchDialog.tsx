import { useEffect, useId, useMemo, useRef } from "react";
import { useI18n } from "../../../shared/i18n/I18nProvider";
import { SEARCH_SECTIONS } from "../searchSections";

type SearchDialogProps = {
  open: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
};

export function SearchDialog({ open, query, onQueryChange, onClose }: SearchDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return SEARCH_SECTIONS;
    }

    return SEARCH_SECTIONS.filter((section) => t(section.labelKey).toLowerCase().includes(normalized));
  }, [query, t]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    inputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="search-dialog" role="presentation" onClick={onClose}>
      <div
        className="search-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="search-dialog__header">
          <h2 className="search-dialog__title" id={titleId}>
            {t("search.dialog.title")}
          </h2>
          <button type="button" className="ps-button ps-button--secondary" onClick={onClose}>
            {t("search.dialog.close")}
          </button>
        </header>

        <label className="search-dialog__field">
          <span className="visually-hidden">{t("header.search.label")}</span>
          <input
            ref={inputRef}
            className="ps-input"
            type="search"
            value={query}
            placeholder={t("search.dialog.placeholder")}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>

        <ul className="search-dialog__results" role="listbox" aria-label={t("search.dialog.title")}>
          {results.length === 0 ? (
            <li className="search-dialog__empty" role="status">
              {t("search.dialog.empty")}
            </li>
          ) : (
            results.map((section) => (
              <li key={section.id}>
                <a
                  className="search-dialog__result"
                  href={section.href}
                  role="option"
                  onClick={onClose}
                >
                  {t(section.labelKey)}
                </a>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
