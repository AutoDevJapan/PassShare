import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { loadCurrentItem, loadItemDetails, loadItemOverviewPage } from "@shared/lib/item-detail-loading";
import { copyTextWithAutoClear } from "@shared/ui/clipboard-auto-clear";
import { connectItemFromApi, connectItemToCreateBody } from "../../lib/connect-items";
import { parseOnepasswordCsv } from "../../lib/csv-import";
import { importAttempt, importFingerprint, saveImportAttempt, finishImportAttempt, acquireImportAttempt, releaseImportAttempt, type ImportAttempt } from "../../lib/import-attempt";
import { useAuthSession } from "../../hooks/useAuthSession";
import { useItemLabels } from "../../hooks/useItemLabels";
import { CloudBoxGate } from "./CloudEncryptionPage";

export function ItemsPage() {
  const { vaultId } = useParams();
  const { user } = useAuthSession();
  return <CloudBoxGate compatibility={(ensureCompatibility) =>
    <CompatibilityItemsPage key={`${user?.id}:${vaultId}`} ensureCompatibility={ensureCompatibility} />} />;
}

function CompatibilityItemsPage({ ensureCompatibility }: { ensureCompatibility: () => Promise<void> }) {
  const { vaultId = "" } = useParams();
  const { t } = useI18n();
  const labels = useItemLabels();
  const { user, connectClient, connectLoading, refreshConnect } = useAuthSession();
  const activeScope = useRef("");
  activeScope.current = `${user?.id ?? ""}:${vaultId}`;
  useLayoutEffect(() => {
    activeScope.current = `${user?.id ?? ""}:${vaultId}`;
    return () => { activeScope.current = ""; loadGeneration.current += 1; };
  }, [vaultId, user?.id]);
  const [vaultName, setVaultName] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsReady, setItemsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const createOperation = useRef<string | null>(null);
  const csvAttempt = useRef<ImportAttempt | null>(null);
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
    if (!connectClient || !vaultId) {
      setItemsLoading(false);
      setError(t("app.item.loadError"));
      return;
    }
    setError(null);
    try {
      const vault = await connectClient.getVault(vaultId);
      await ensureCompatibility();
      if (generation !== loadGeneration.current) return;
      const overviews = await loadItemOverviewPage(connectClient,vaultId,async()=>{
        await ensureCompatibility();if(generation!==loadGeneration.current)throw new Error('Inactive item list');
      });
      if (generation !== loadGeneration.current) return;
      setVaultName(vault.name);
      if(overviews.some(row=>(row as typeof row & {listMetadataVersion?:number}).listMetadataVersion!==1)){
        const details=await loadItemDetails(overviews,id=>connectClient.getItem(vaultId,id),async()=>{await ensureCompatibility();if(generation!==loadGeneration.current)throw new Error('Inactive list');});
        if(generation!==loadGeneration.current)return;
        setItems(details.map(connectItemFromApi));
      }else setItems(overviews.map(overview=>{
        const metadata=overview as typeof overview & {username?:string;favorite?:boolean;hasPassword?:boolean;hasBody?:boolean;bodyPreview?:string};
        return {...connectItemFromApi({...overview,fields:[]} as Item),username:metadata.username??'',favorite:metadata.favorite??false,hasPassword:metadata.hasPassword,hasBody:metadata.hasBody,body:metadata.bodyPreview};
      }));
      setItemsReady(true);
    } catch {
      if (generation === loadGeneration.current) setError(t("app.item.loadError"));
    } finally {
      if (generation === loadGeneration.current) setItemsLoading(false);
    }
  }, [connectClient, vaultId, t, ensureCompatibility]);

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
      await ensureCompatibility();
      if (scope !== activeScope.current) return;
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
      await ensureCompatibility();
      if (scope !== activeScope.current) return;
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
      await ensureCompatibility();
      if (scope !== activeScope.current) return;
      await connectClient.deleteItem(vaultId, itemId);
      if (scope === activeScope.current) await loadItems();
    } catch {
      if (scope === activeScope.current) setError(t("app.item.deleteError"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function currentDetail(id:string) {
    if(!connectClient)throw new Error('Inactive client');
    const scope=activeScope.current,generation=loadGeneration.current;
    return loadCurrentItem(()=>connectClient.getItem(vaultId,id),async()=>{
      await ensureCompatibility();
      if(scope!==activeScope.current||generation!==loadGeneration.current)throw new Error('Inactive request');
    });
  }
  async function startEdit(item: ConnectItem) {
    if (busyRef.current || itemsLoading) return;
    busyRef.current=true;setBusy(true);
    const scope=activeScope.current,generation=loadGeneration.current;
    try{
      const detail=await currentDetail(item.id);
      createOperation.current = null;setMode("edit");setEditingItem(detail);
      setFormValues(formValuesFromItem(connectItemFromApi(detail)));
    }catch{if(scope===activeScope.current&&generation===loadGeneration.current)setError(t('app.item.loadError'));}finally{busyRef.current=false;setBusy(false);}
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
    let changed = 0;
    let ownedAttempt: ImportAttempt | null = null;
    try {
      const text = await file.text();
      const parsed = parseOnepasswordCsv(text);
      const fingerprint = await importFingerprint(text);
      if (scope !== activeScope.current) return;
      const attempt = importAttempt(csvAttempt.current, scope, fingerprint, parsed.length);
      acquireImportAttempt(attempt);
      ownedAttempt = attempt;
      csvAttempt.current = attempt;
      imported = 0;
      for (const [index, row] of parsed.entries()) {
        await ensureCompatibility();
        if (scope !== activeScope.current) return;
        const alreadyCompleted = attempt.completed.has(index);
        try {
          await connectClient.createItem(vaultId, connectItemToCreateBody(row), attempt.keys[index]);
        } catch (error) {
          if (alreadyCompleted && typeof error === "object" && error !== null && "status" in error && error.status === 409 && "code" in error && error.code === "PS015") {
            changed += 1;
            continue;
          }
          throw error;
        }
        attempt.completed.add(index);
        imported += 1;
        saveImportAttempt(attempt);
      }
      if (scope !== activeScope.current) return;
      if (changed) {
        await loadItems();
        if (scope === activeScope.current) setError(t("app.item.importPartialError").replace("{count}", String(imported)));
        return;
      }
      finishImportAttempt(attempt);
      csvAttempt.current = null;
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
      if (ownedAttempt) releaseImportAttempt(ownedAttempt);
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
    let ownedAttempt: ImportAttempt | null = null;
    try {
      const archiveBytes=new Uint8Array(await file.arrayBuffer());
      let fingerprint:string;
      try{fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',archiveBytes)),b=>b.toString(16).padStart(2,'0')).join('');}finally{archiveBytes.fill(0);}
      if(scope!==activeScope.current)return;
      const attempt=importAttempt(null,`${scope}:1pux`,fingerprint,1);
      acquireImportAttempt(attempt);ownedAttempt=attempt;
      // The importer can issue several item requests; guard each request too.
      const guardedClient = new Proxy(connectClient, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            await ensureCompatibility();
            if (scope !== activeScope.current) throw new Error("Inactive item request");
            return Reflect.apply(value, target, args);
          };
        },
      });
      const result = await import1puxFile(guardedClient, vaultId, file, attempt.keys[0]);
      if (scope !== activeScope.current) return;
      if(result.partial){await loadItems();if(scope===activeScope.current)setError(t("app.item.importPartialError").replace("{count}",String(result.imported)));return;}
      finishImportAttempt(attempt);
      setImportMessage(labels.import1puxSuccess.replace("{count}", String(result.imported)));
      await loadItems();
    } catch {
      if (scope === activeScope.current) {
        const reloadGeneration = loadGeneration.current + 1;
        await loadItems();
        if (reloadGeneration === loadGeneration.current) setError(t("app.item.import1puxError"));
      }
    } finally {
      if(ownedAttempt)releaseImportAttempt(ownedAttempt);
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleExportCsv() {
    if (!itemsReady || busyRef.current || !window.confirm(t("app.item.exportWarning"))) return;
    busyRef.current=true;setBusy(true);
    const scope=activeScope.current,generation=loadGeneration.current;
    const ensureExport=async()=>{await ensureCompatibility();if(scope!==activeScope.current||generation!==loadGeneration.current)throw new Error('Inactive export');};
    try{const details=await loadItemDetails(items,currentDetail,ensureExport);await ensureExport();if(scope!==activeScope.current||generation!==loadGeneration.current)throw new Error('Inactive export');downloadCsvFile("passshare-export.csv", exportOnepasswordCsv(details.map(connectItemFromApi)));setExportMessage(labels.exportSuccess);}
    catch{if(scope===activeScope.current&&generation===loadGeneration.current)setError(t('app.item.loadError'));}finally{busyRef.current=false;setBusy(false);}
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
        {itemsReady && items.length === 0 && <Link to={`/app/vaults/${vaultId}/encryption`} className="ps-button ps-button--secondary">
          {t("cloud.setupTitle")}
        </Link>}
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
            copyItem={async item=>{const scope=activeScope.current,generation=loadGeneration.current;try{const detail=connectItemFromApi(await currentDetail(item.id));if(scope!==activeScope.current||generation!==loadGeneration.current)return false;const secret=detail.password||detail.body||'';if(!secret)return false;await copyTextWithAutoClear(secret);return true;}catch{if(scope===activeScope.current&&generation===loadGeneration.current)setError(t('app.item.loadError'));return false;}}}
            onDelete={(id) => void handleDelete(id)}
          />
          {itemsLoading ? <p role="status">{t("session.loading")}</p> : itemsReady && filteredItems.length === 0 ? <p>{labels.emptyList}</p> : null}
        </div>
      </div>
    </section>
  );
}
