import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConnectItemList } from "@shared/ui/ConnectItemList.js";
import { ItemForm } from "@shared/ui/ItemForm.js";
import type { ConnectItem, ItemFormValues } from "@shared/types/item.js";
import { emptyFormValues, formValuesFromItem } from "@shared/types/item.js";
import { useI18n } from "@shared/i18n/I18nProvider";
import { import1puxFile } from "@shared/lib/1pux-import";
import { downloadCsvFile, exportOnepasswordCsv } from "@shared/lib/csv-export";
import { generatePassword } from "@shared/lib/password-generator";
import { connectItemFromApi, connectItemToCreateBody } from "../../lib/connect-items";
import { parseOnepasswordCsv } from "../../lib/csv-import";
import { useAuthSession } from "../../hooks/useAuthSession";
import { useItemLabels } from "../../hooks/useItemLabels";

export function ItemsPage() {
  const { vaultId = "" } = useParams();
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
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const puxInputRef = useRef<HTMLInputElement>(null);

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

  async function handleCsvImport(file: File) {
    if (!connectClient) {
      return;
    }
    setError(null);
    setImportMessage(null);
    try {
      const text = await file.text();
      const parsed = parseOnepasswordCsv(text);
      for (const row of parsed) {
        await connectClient.createItem(vaultId, connectItemToCreateBody(row));
      }
      setImportMessage(labels.importSuccess.replace("{count}", String(parsed.length)));
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.item.importError"));
    }
  }

  async function handle1puxImport(file: File) {
    if (!connectClient) {
      return;
    }
    setError(null);
    setImportMessage(null);
    try {
      const result = await import1puxFile(connectClient, vaultId, file);
      setImportMessage(labels.import1puxSuccess.replace("{count}", String(result.imported)));
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.item.importError"));
    }
  }

  function handleExportCsv() {
    downloadCsvFile("passshare-export.csv", exportOnepasswordCsv(items));
    setExportMessage(labels.exportSuccess);
  }

  if (connectLoading) {
    return <div className="app-loading">{t("session.loading")}</div>;
  }

  return (
    <section className="app-page app-page--items">
      <header className="app-page__header">
        <Link to="/app/vaults" className="app-back-link">
          {t("app.vault.back")}
        </Link>
        <h1 className="ps-heading-2">{vaultName || t("app.item.listHeading")}</h1>
        <Link to={`/app/vaults/${vaultId}/share`} className="ps-button ps-button--secondary">
          {t("app.share.link")}
        </Link>
      </header>

      <div className="app-items-toolbar">
        <input
          className="ps-input"
          type="search"
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={labels.searchPlaceholder}
        />
        <button type="button" className="ps-button" onClick={() => fileInputRef.current?.click()}>
          {labels.importCsv}
        </button>
        <button type="button" className="ps-button ps-button--secondary" onClick={() => puxInputRef.current?.click()}>
          {labels.import1pux}
        </button>
        <button type="button" className="ps-button ps-button--secondary" onClick={handleExportCsv}>
          {labels.exportCsv}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void handleCsvImport(file);
            }
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={puxInputRef}
          type="file"
          accept=".1pux,.zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void handle1puxImport(file);
            }
            event.currentTarget.value = "";
          }}
        />
      </div>

      {importMessage ? <p className="app-success">{importMessage}</p> : null}
      {exportMessage ? <p className="app-success">{exportMessage}</p> : null}
      {error ? (
        <p className="ps-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="app-items-layout">
        <div className="app-items-layout__form">
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
        </div>

        <div className="app-items-layout__list">
          <ConnectItemList
            items={filteredItems}
            labels={labels}
            onEdit={startEdit}
            onDelete={(id) => void handleDelete(id)}
          />
          {filteredItems.length === 0 ? <p>{labels.emptyList}</p> : null}
        </div>
      </div>
    </section>
  );
}
