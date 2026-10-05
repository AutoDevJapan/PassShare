import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Vault } from "@passshare/connect";
import { formatVaultItemCount } from "@shared/i18n/index";
import { useI18n } from "@shared/i18n/I18nProvider";
import { AuthApiError, createPasswordBox } from "../lib/auth-api";
import { loadAuthSession } from "../lib/secure-storage";
import { useAuthSession } from "../hooks/useAuthSession";

type Props = {
  onSelectVault: (vaultId: string) => void;
};

export function VaultListPanel({ onSelectVault }: Props) {
  const { t, locale } = useI18n();
  const { user, connectClient, connectLoading, refreshConnect } = useAuthSession();
  const createOperation = useRef<string | null>(null);
  const userScope = useRef(user?.id);
  userScope.current = user?.id;
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadVaults = useCallback(async () => {
    if (!connectClient) {
      return;
    }
    setError(null);
    const actor = userScope.current;
    try {
      const next = await connectClient.listVaults();
      if (userScope.current === actor) setVaults(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.vault.loadError"));
    }
  }, [connectClient, t]);

  useEffect(() => {
    createOperation.current = null;
    setName("");
    setVaults([]);
  }, [user?.id]);

  useEffect(() => {
    void loadVaults();
  }, [loadVaults]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || creating) {
      return;
    }
    setCreating(true);
    setError(null);
    const actor = user?.id;
    try {
      const session = await loadAuthSession(t("mobile.lock.biometricReason"));
      if (!session?.refreshToken) {
        throw new AuthApiError("Session expired");
      }
      createOperation.current ??= crypto.randomUUID();
      await createPasswordBox(session.refreshToken, name.trim(), createOperation.current);
      if (userScope.current !== actor) return;
      createOperation.current = null;
      await refreshConnect();
      setName("");
      await loadVaults();
    } catch (err) {
      if (userScope.current === actor) setError(err instanceof AuthApiError ? err.message : t("app.vault.createError"));
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
              <p className="mobile-vault-card__meta">{formatVaultItemCount(vault.items, locale)}</p>
            </button>
          </li>
        ))}
      </ul>

      {vaults.length === 0 ? <p>{t("app.vault.empty")}</p> : null}
    </section>
  );
}
