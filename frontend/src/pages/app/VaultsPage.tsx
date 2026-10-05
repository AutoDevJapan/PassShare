import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import { formatVaultItemCount } from "@shared/i18n/index";
import type { Vault } from "@passshare/connect";
import { AuthApiError, createPasswordBox } from "../../lib/auth-api";
import { useAuthSession } from "../../hooks/useAuthSession";

export function VaultsPage() {
  const { t, locale } = useI18n();
  const { user, connectClient, connectLoading, refreshConnect } = useAuthSession();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const createOperation = useRef<string | null>(null);
  const userScope = useRef(user?.id);
  userScope.current = user?.id;
  const loadGeneration = useRef(0);

  const loadVaults = useCallback(async (client = connectClient) => {
    const generation = ++loadGeneration.current;
    if (!client) {
      setVaults([]);
      return;
    }
    setError(null);
    try {
      const nextVaults = await client.listVaults();
      if (generation === loadGeneration.current) setVaults(nextVaults);
    } catch {
      if (generation === loadGeneration.current) setError(t("app.vault.loadError"));
    }
  }, [connectClient, t]);

  useEffect(() => {
    createOperation.current = null;
    setName("");
    setVaults([]);
  }, [user?.id]);

  useEffect(() => {
    void loadVaults();
    return () => { loadGeneration.current += 1; };
  }, [loadVaults]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || creatingRef.current) {
      return;
    }
    setCreating(true);
    creatingRef.current = true;
    setError(null);
    const actor = user?.id;
    try {
      createOperation.current ??= crypto.randomUUID();
      await createPasswordBox(name.trim(), createOperation.current);
      if (userScope.current !== actor) return;
      createOperation.current = null;
      setName("");
      const client = await refreshConnect();
      if (client) await loadVaults(client);
      else setError(t("app.vault.loadError"));
    } catch (err) {
      if (userScope.current === actor) setError(err instanceof AuthApiError ? err.message : t("app.vault.createError"));
    } finally {
      setCreating(false);
      creatingRef.current = false;
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
