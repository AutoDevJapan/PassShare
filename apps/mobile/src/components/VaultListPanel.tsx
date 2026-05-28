import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Vault } from "@passshare/connect";
import { useI18n } from "@shared/i18n/I18nProvider";
import { AuthApiError, createPasswordBox } from "../lib/auth-api";
import { loadRefreshToken } from "../lib/secure-storage";
import { useAuthSession } from "../hooks/useAuthSession";

type Props = {
  onSelectVault: (vaultId: string) => void;
};

export function VaultListPanel({ onSelectVault }: Props) {
  const { t } = useI18n();
  const { connectClient, connectLoading, refreshConnect } = useAuthSession();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      const refreshToken = await loadRefreshToken();
      if (!refreshToken) {
        throw new AuthApiError("Session expired");
      }
      await createPasswordBox(refreshToken, name.trim());
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
    return <div className="mobile-loading">{t("session.loading")}</div>;
  }

  return (
    <section className="mobile-panel">
      <header className="mobile-panel__header">
        <h1 className="ps-heading-2">{t("app.vault.title")}</h1>
        <p className="mobile-panel__lead">{t("app.vault.lead")}</p>
      </header>

      <form className="mobile-form ps-card" onSubmit={(event) => void handleCreate(event)}>
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

      <ul className="mobile-vault-list">
        {vaults.map((vault) => (
          <li key={vault.id}>
            <button type="button" className="mobile-vault-card ps-card" onClick={() => onSelectVault(vault.id)}>
              <h2 className="ps-heading-3">{vault.name}</h2>
              <p className="mobile-vault-card__meta">
                {vault.items}
                {t("app.vault.itemCountSuffix")}
              </p>
            </button>
          </li>
        ))}
      </ul>

      {vaults.length === 0 ? <p>{t("app.vault.empty")}</p> : null}
    </section>
  );
}
