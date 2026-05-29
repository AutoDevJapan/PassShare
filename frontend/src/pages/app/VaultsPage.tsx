import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import { formatVaultItemCount } from "@shared/i18n/index";
import type { Vault } from "@passshare/connect";
import { AuthApiError, createPasswordBox } from "../../lib/auth-api";
import { useAuthSession } from "../../hooks/useAuthSession";

export function VaultsPage() {
  const { t, locale } = useI18n();
  const { connectClient, connectLoading, refreshConnect } = useAuthSession();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const loadVaults = useCallback(async () => {
    if (!connectClient) {
      return;
    }
    setError(null);
    try {
      setVaults(await connectClient.listVaults());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.vault.loadError"));
    }
  }, [connectClient, t]);

  useEffect(() => {
    void loadVaults();
  }, [loadVaults]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createPasswordBox(name.trim());
      await refreshConnect();
      setName("");
      await loadVaults();
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : t("app.vault.createError"));
    } finally {
      setCreating(false);
    }
  }

  if (connectLoading) {
    return <div className="app-loading">{t("session.loading")}</div>;
  }

  return (
    <section className="app-page">
      <header className="app-page__header">
        <h1 className="ps-heading-2">{t("app.vault.title")}</h1>
        <p className="app-page__lead">{t("app.vault.lead")}</p>
      </header>

      <form className="app-inline-form ps-card" onSubmit={(event) => void handleCreate(event)}>
        <label className="ps-label ps-label--full">
          {t("app.vault.createLabel")}
          <input
            className="ps-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("app.vault.createPlaceholder")}
          />
        </label>
        <button type="submit" className="ps-button" disabled={creating || !name.trim()}>
          {t("app.vault.createSubmit")}
        </button>
      </form>

      {error ? (
        <p className="ps-error" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="app-vault-list">
        {vaults.map((vault) => (
          <li key={vault.id}>
            <Link className="app-vault-card ps-card" to={`/app/vaults/${vault.id}/items`}>
              <h2 className="ps-heading-3">{vault.name}</h2>
              <p className="app-vault-card__meta">{formatVaultItemCount(vault.items, locale)}</p>
            </Link>
          </li>
        ))}
      </ul>

      {vaults.length === 0 ? <p>{t("app.vault.empty")}</p> : null}
    </section>
  );
}
