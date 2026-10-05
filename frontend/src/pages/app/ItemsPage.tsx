import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Item } from "@passshare/connect";
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
  const { user, connectClient, connectLoading, refreshConnect } = useAuthSession();
  const activeScope = useRef("");
  activeScope.current = `${user?.id ?? ""}:${vaultId}`;
  const [vaultName, setVaultName] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [documents, setDocuments] = useState<Record<string, Item>>({});
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsReady, setItemsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const createOperation = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"create" | "edit" | null>("create");
  const [formValues, setFormValues] = useState<ItemFormValues>(emptyFormValues());
  const [editingItem, setEditingItem] = useState<Item | null>(null);
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
        item.url?.toLowerCase().includes(normalized) ||
        item.tags.some((tag) => tag.toLowerCase().includes(normalized)),
    );
  }, [items, query]);

  const loadItems = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setItemsLoading(true);
    setItemsReady(false);
    setItems([]);
    setDocuments({});
    if (!connectClient || !vaultId) {
      setItemsLoading(false);
      setError(t("app.item.loadError"));
      return;
    }
    setError(null);
    try {
      const vault = await connectClient.getVault(vaultId);
      const overviews = await connectClient.listItems(vaultId);
      const details = await Promise.all(
        overviews.map((overview) => connectClient.getItem(vaultId, overview.id)),
      );
      if (generation !== loadGeneration.current) return;
      setVaultName(vault.name);
      setDocuments(Object.fromEntries(details.map((item) => [item.id, item])));
      setItems(details.map(connectItemFromApi));
      setItemsReady(true);
    } catch {
      if (generation === loadGeneration.current) setError(t("app.item.loadError"));
    } finally {
      if (generation === loadGeneration.current) setItemsLoading(false);
    }
  }, [connectClient, vaultId, t]);

  useEffect(() => {
    void loadItems();
    return () => { loadGeneration.current += 1; };
  }, [loadItems]);

  useEffect(() => {
    createOperation.current = null;
    setVaultName("");
    setMode("create");
    setEditingItem(null);
    setFormValues(emptyFormValues());
    setImportMessage(null);
    setExportMessage(null);
  }, [vaultId, user?.id]);

  async function handleReload() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const scope = activeScope.current;
    try {
      // Acquire fresh scopes and credentials, including after a token expired.
      const client = await refreshConnect();
      if (!client && scope === activeScope.current) setError(t("app.item.loadError"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleCreate(values: ItemFormValues) {
    if (!connectClient || !itemsReady || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const scope = activeScope.current;
    try {
      createOperation.current ??= crypto.randomUUID();
      await connectClient.createItem(vaultId, connectItemToCreateBody(values), createOperation.current);
      if (scope !== activeScope.current) return;
      createOperation.current = null;
      setMode(null);
      setFormValues(emptyFormValues());
      await loadItems();
    } catch (err) {
      const conflict = err instanceof Error && "status" in err && err.status === 409;
      if (scope === activeScope.current) setError(t(conflict ? "app.item.createConflictError" : "app.item.createResultUnknown"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleUpdate(values: ItemFormValues) {
    if (!connectClient || !editingItem || !itemsReady || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const scope = activeScope.current;
    try {
      await connectClient.editItemForm(vaultId, editingItem.id, editingItem.version, values);
      if (scope !== activeScope.current) return;
      setMode(null);
      setEditingItem(null);
      setFormValues(emptyFormValues());
      await loadItems();
    } catch (err) {
      const conflict = err instanceof Error && "status" in err && err.status === 409;
      if (scope === activeScope.current) setError(t(conflict ? "app.item.conflictError" : "app.item.saveError"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleDelete(itemId: string) {
    if (!connectClient || !itemsReady || busyRef.current || !window.confirm(labels.confirmDelete)) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const scope = activeScope.current;
    try {
      await connectClient.deleteItem(vaultId, itemId);
      if (scope === activeScope.current) await loadItems();
    } catch {
      if (scope === activeScope.current) setError(t("app.item.deleteError"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function startEdit(item: ConnectItem) {
    if (busyRef.current || itemsLoading || !documents[item.id]) return;
    createOperation.current = null;
    setMode("edit");
    setEditingItem(documents[item.id]);
    setFormValues(formValuesFromItem(item));
  }

  async function handleCsvImport(file: File) {
    if (!connectClient || !itemsReady || busyRef.current) {
      return;
    }
    setError(null);
    setImportMessage(null);
    busyRef.current = true;
    setBusy(true);
    const scope = activeScope.current;
    let imported = 0;
    try {
      const text = await file.text();
      const parsed = parseOnepasswordCsv(text);
      for (const row of parsed) {
        if (scope !== activeScope.current) return;
        await connectClient.createItem(vaultId, connectItemToCreateBody(row));
        imported += 1;
      }
      if (scope !== activeScope.current) return;
      setImportMessage(labels.importSuccess.replace("{count}", String(parsed.length)));
      await loadItems();
    } catch {
      if (scope === activeScope.current) {
        // Show successfully created rows before reporting the partial failure.
        const reloadGeneration = loadGeneration.current + 1;
        await loadItems();
        if (reloadGeneration === loadGeneration.current) setError(t("app.item.importPartialError").replace("{count}", String(imported)));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handle1puxImport(file: File) {
    if (!connectClient || !itemsReady || busyRef.current) {
      return;
    }
    setError(null);
    setImportMessage(null);
    busyRef.current = true;
    setBusy(true);
    const scope = activeScope.current;
    try {
      const result = await import1puxFile(connectClient, vaultId, file);
      if (scope !== activeScope.current) return;
      setImportMessage(labels.import1puxSuccess.replace("{count}", String(result.imported)));
      await loadItems();
    } catch {
      if (scope === activeScope.current) {
        const reloadGeneration = loadGeneration.current + 1;
        await loadItems();
        if (reloadGeneration === loadGeneration.current) setError(t("app.item.import1puxError"));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function handleExportCsv() {
    if (!itemsReady || busyRef.current || !window.confirm(t("app.item.exportWarning"))) return;
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
        <button type="button" className="ps-button ps-button--secondary" disabled={itemsLoading || busy} onClick={() => void handleReload()}>
          {t("app.item.reload")}
        </button>
        <input
          className="ps-input"
          type="search"
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={labels.searchPlaceholder}
        />
        <button type="button" className="ps-button" disabled={!itemsReady || busy} onClick={() => fileInputRef.current?.click()}>
          {labels.importCsv}
        </button>
        <button type="button" className="ps-button ps-button--secondary" disabled={!itemsReady || busy} onClick={() => puxInputRef.current?.click()}>
          {labels.import1pux}
        </button>
        <button type="button" className="ps-button ps-button--secondary" disabled={!itemsReady || busy} onClick={handleExportCsv}>
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
              disabled={!itemsReady || busy}
              onChange={setFormValues}
              onSubmit={(values) => void handleUpdate(values)}
              onCancel={() => {
                setMode("create");
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
              values={formValues}
              labels={labels}
              disabled={!itemsReady || busy}
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
          {itemsLoading ? <p role="status">{t("session.loading")}</p> : itemsReady && filteredItems.length === 0 ? <p>{labels.emptyList}</p> : null}
        </div>
      </div>
    </section>
  );
}
