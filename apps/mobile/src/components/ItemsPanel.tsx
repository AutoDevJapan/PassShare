import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectItemList } from "@shared/ui/ConnectItemList.js";
import { ItemForm } from "@shared/ui/ItemForm.js";
import type { ConnectItem, ItemFormValues } from "@shared/types/item.js";
import { emptyFormValues, formValuesFromItem } from "@shared/types/item.js";
import { useI18n } from "@shared/i18n/I18nProvider";
import { generatePassword } from "@shared/lib/password-generator";
import { connectItemFromApi, connectItemToCreateBody } from "../lib/connect-items";
import { useAuthSession } from "../hooks/useAuthSession";
import { useItemLabels } from "../hooks/useItemLabels";

type Props = {
  vaultId: string;
  onBack: () => void;
};

export function ItemsPanel({ vaultId, onBack }: Props) {
  const { t } = useI18n();
  const labels = useItemLabels();
  const { connectClient, connectLoading } = useAuthSession();
  const [vaultName, setVaultName] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"create" | "edit" | null>("create");
  const [formValues, setFormValues] = useState<ItemFormValues>(emptyFormValues());
  const [editingId, setEditingId] = useState<string | null>(null);
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
    try {
      const vault = await connectClient.getVault(vaultId);
      setVaultName(vault.name);
      const overviews = await connectClient.listItems(vaultId);
      const details = await Promise.all(
        overviews.map((overview) => connectClient.getItem(vaultId, overview.id)),
      );
      setItems(details.map(connectItemFromApi));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.item.loadError"));
    }
  }, [connectClient, vaultId, t]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function handleCreate(values: ItemFormValues) {
    if (!connectClient) {
      return;
    }
    await connectClient.createItem(vaultId, connectItemToCreateBody(values));
    setMode(null);
    setFormValues(emptyFormValues());
    await loadItems();
  }

  async function handleUpdate(values: ItemFormValues) {
    if (!connectClient || !editingId) {
      return;
    }
    await connectClient.replaceItem(vaultId, editingId, connectItemToCreateBody(values));
    setMode(null);
    setEditingId(null);
    setFormValues(emptyFormValues());
    await loadItems();
  }

  async function handleDelete(itemId: string) {
    if (!connectClient || !window.confirm(labels.confirmDelete)) {
      return;
    }
    await connectClient.deleteItem(vaultId, itemId);
    await loadItems();
  }

  function startEdit(item: ConnectItem) {
    setMode("edit");
    setEditingId(item.id);
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
            values={formValues}
            labels={labels}
            onChange={setFormValues}
            onSubmit={(values) => void handleUpdate(values)}
            onCancel={() => {
              setMode("create");
              setEditingId(null);
              setFormValues(emptyFormValues());
            }}
            onGeneratePassword={() =>
              setFormValues((current) => ({ ...current, password: generatePassword() }))
            }
          />
        ) : (
          <ItemForm
            mode="create"
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
