import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Item } from "@passshare/connect";
import { ConnectItemList } from "@shared/ui/ConnectItemList.js";
import { ItemForm } from "@shared/ui/ItemForm.js";
import type { ConnectItem, ItemFormValues } from "@shared/types/item.js";
import { emptyFormValues, formValuesFromItem } from "@shared/types/item.js";
import { useI18n } from "@shared/i18n/I18nProvider";
import { generatePassword } from "@shared/lib/password-generator";
import { connectItemFromApi, connectItemToCreateBody } from "../lib/connect-items";
import { useAuthSession } from "../hooks/useAuthSession";
import { useItemLabels } from "../hooks/useItemLabels";

import { CloudBoxPanel } from "@shared/cloud/CloudBoxPanel";
type Props = {
  vaultId: string;
  onBack: () => void;
};

export function ItemsPanel(props: Props) {
  const { cloudSession } = useAuthSession();
  const { t } = useI18n();
  if (!cloudSession) return <p role="status">{t("session.loading")}</p>;
  return <><button type="button" className="ps-button ps-button--secondary" onClick={props.onBack}>{t("app.vault.back")}</button>
    <CloudBoxPanel key={`${cloudSession.userId}:${props.vaultId}`} session={cloudSession} boxId={props.vaultId}
      compatibility={(ensureCompatibility) => <CompatibilityItemsPanel {...props} ensureCompatibility={ensureCompatibility} />} /></>;
}
function CompatibilityItemsPanel({ vaultId, onBack, ensureCompatibility }: Props & { ensureCompatibility: () => Promise<void> }) {
  const { t } = useI18n();
  const labels = useItemLabels();
  const { user, connectClient, connectLoading } = useAuthSession();
  const scope = useRef("");
  scope.current = `${user?.id ?? ""}:${vaultId}`;
  const createOperation = useRef<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [documents, setDocuments] = useState<Record<string, Item>>({});
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"create" | "edit" | null>("create");
  const [formValues, setFormValues] = useState<ItemFormValues>(emptyFormValues());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return items;
    }
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(normalized) ||
        item.username?.toLowerCase().includes(normalized) ||
        item.tags.some((tag) => tag.toLowerCase().includes(normalized)),
    );
  }, [items, query]);

  const loadItems = useCallback(async () => {
    if (!connectClient || !vaultId) {
      return;
    }
    setError(null);
    const active = scope.current;
    try {
      await ensureCompatibility();
      const vault = await connectClient.getVault(vaultId);
      if (active !== scope.current) return;
      setVaultName(vault.name);
      const overviews = await connectClient.listItems(vaultId);
      const details = await Promise.all(
        overviews.map((overview) => connectClient.getItem(vaultId, overview.id)),
      );
      if (active !== scope.current) return;
      setItems(details.map(connectItemFromApi));
      setDocuments(Object.fromEntries(details.map((item) => [item.id, item])));
    } catch (err) {
      if (active === scope.current) setError(t("app.item.loadError"));
    }
  }, [connectClient, vaultId, t, ensureCompatibility]);

  useEffect(() => {
    createOperation.current = null;
    setDocuments({});
    setItems([]);
    setEditingId(null);
    setEditingItem(null);
    setFormValues(emptyFormValues());
    setMode("create");
  }, [user?.id, vaultId]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function handleCreate(values: ItemFormValues) {
    if (!connectClient || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const active = scope.current;
    createOperation.current ??= crypto.randomUUID();
    try {
      await ensureCompatibility();
      await connectClient.createItem(vaultId, connectItemToCreateBody(values), createOperation.current);
    } catch (err) { const conflict = err instanceof Error && "status" in err && err.status === 409;
      if (active === scope.current) setError(t(conflict ? "app.item.createConflictError" : "app.item.createResultUnknown")); return; }
    finally { busyRef.current = false; setBusy(false); }
    if (active !== scope.current) return;
    createOperation.current = null;
    setMode(null);
    setFormValues(emptyFormValues());
    await loadItems();
  }

  async function handleUpdate(values: ItemFormValues) {
    if (!connectClient || !editingId || !editingItem || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const active = scope.current;
    try { await ensureCompatibility(); await connectClient.editItemForm(vaultId, editingId, editingItem.version, values); }
    catch { if (active === scope.current) setError(t("app.item.saveError")); return; }
    finally { busyRef.current = false; setBusy(false); }
    if (active !== scope.current) return;
    setMode(null);
    setEditingId(null);
    setEditingItem(null);
    setFormValues(emptyFormValues());
    await loadItems();
  }

  async function handleDelete(itemId: string) {
    if (!connectClient || busyRef.current || !window.confirm(labels.confirmDelete)) {
      return;
    }
    await ensureCompatibility();
    await connectClient.deleteItem(vaultId, itemId);
    await loadItems();
  }

  function startEdit(item: ConnectItem) {
    if (busyRef.current || !documents[item.id]) return;
    createOperation.current = null;
    setMode("edit");
    setEditingId(item.id);
    setEditingItem(documents[item.id]);
    setFormValues(formValuesFromItem(item));
  }

  if (connectLoading) {
    return <div className="mobile-loading">{t("session.loading")}</div>;
  }

  return (
    <section className="mobile-panel mobile-panel--items">
      <header className="mobile-panel__header">
        <button type="button" className="mobile-back-button" onClick={onBack}>
          {t("app.vault.back")}
        </button>
        <h1 className="ps-heading-2">{vaultName || t("app.item.listHeading")}</h1>
      </header>

      <input
        className="ps-input mobile-search"
        type="search"
        placeholder={labels.searchPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={labels.searchPlaceholder}
      />

      {error ? (
        <p className="ps-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mobile-items-stack">
        {mode === "edit" ? (
          <ItemForm
            mode="edit"
            disabled={busy}
            values={formValues}
            labels={labels}
            onChange={setFormValues}
            onSubmit={(values) => void handleUpdate(values)}
            onCancel={() => {
              if (busyRef.current) return;
              setMode("create");
              setEditingId(null);
              setEditingItem(null);
              setFormValues(emptyFormValues());
            }}
            onGeneratePassword={() =>
              setFormValues((current) => ({ ...current, password: generatePassword() }))
            }
          />
        ) : (
          <ItemForm
            mode="create"
            disabled={busy}
            values={formValues}
            labels={labels}
            onChange={setFormValues}
            onSubmit={(values) => void handleCreate(values)}
            onGeneratePassword={() =>
              setFormValues((current) => ({ ...current, password: generatePassword() }))
            }
          />
        )}

        <ConnectItemList
          items={filteredItems}
          labels={labels}
          onEdit={startEdit}
          onDelete={(id) => void handleDelete(id)}
        />
        {filteredItems.length === 0 ? <p>{labels.emptyList}</p> : null}
      </div>
    </section>
  );
}
