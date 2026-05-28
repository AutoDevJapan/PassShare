import { useEffect, useRef, useState } from "react";
import { ConnectItemList } from "@shared/ui/ConnectItemList";
import { ItemForm } from "@shared/ui/ItemForm";
import { ClipboardClearSettings } from "@shared/ui/ClipboardClearSettings";
import type { ConnectItem, ItemFormValues } from "@shared/types/item";
import { emptyFormValues, formValuesFromItem } from "@shared/types/item";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
import { useItemLabels } from "../hooks/useItemLabels";
import {
  addItem,
  deleteItem,
  exportOnepasswordCsv,
  generatePassword,
  importOnepasswordCsv,
  listItems,
  lockPasswordBox,
  searchItems,
  updateItem,
} from "../tauri";
import { downloadCsvFile } from "@shared/lib/csv-export";
import { formatTauriError } from "../errors";
import { StatusMessage } from "./StatusMessage";
import { BiometricUnlockSettings } from "./BiometricUnlockSettings";
import { CloudSyncSettings } from "./CloudSyncSettings";

type MainPanelProps = {
  boxPath: string;
  masterPassword: string;
  onLocked: () => void;
};

export function MainPanel({ boxPath, masterPassword, onLocked }: MainPanelProps) {
  const itemLabels = useItemLabels();
  const desktopLabels = useDesktopLabels();
  const [searchQuery, setSearchQuery] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [formValues, setFormValues] = useState<ItemFormValues>(emptyFormValues());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refreshItems(query = searchQuery.trim()) {
    try {
      const nextItems = query ? await searchItems(query) : await listItems();
      setItems(nextItems);
      setListError("");
    } catch (err) {
      setListError(formatTauriError(err));
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const nextItems = await listItems();
        if (!cancelled) {
          setItems(nextItems);
          setListError("");
        }
      } catch (err) {
        if (!cancelled) {
          setListError(formatTauriError(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSearchChange(value: string) {
    setSearchQuery(value);
    await refreshItems(value.trim());
  }

  async function handleLock() {
    await lockPasswordBox();
    onLocked();
  }

  async function handleGenerate() {
    const password = await generatePassword(16);
    setFormValues((current) => ({ ...current, password }));
    setFormError("");
  }

  function resetForm() {
    setFormValues(emptyFormValues());
    setEditingId(null);
    setFormError("");
  }

  async function handleSubmit(values: ItemFormValues) {
    setFormError("");
    try {
      if (editingId) {
        await updateItem({ id: editingId, values, masterPassword });
      } else {
        await addItem({ values, masterPassword });
      }
      resetForm();
      await refreshItems();
    } catch (err) {
      setFormError(formatTauriError(err));
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(itemLabels.confirmDelete)) {
      return;
    }

    try {
      await deleteItem(id, masterPassword);
      if (editingId === id) {
        resetForm();
      }
      await refreshItems();
    } catch (err) {
      setListError(formatTauriError(err));
    }
  }

  function handleEdit(item: ConnectItem) {
    setEditingId(item.id);
    setFormValues(formValuesFromItem(item));
    setFormError("");
  }

  async function handleExportCsv() {
    try {
      const csv = await exportOnepasswordCsv();
      downloadCsvFile("passshare-export.csv", csv);
      setExportMessage(itemLabels.exportSuccess);
    } catch (err) {
      setListError(formatTauriError(err));
    }
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    try {
      const csvData = await file.text();
      const count = await importOnepasswordCsv(csvData, masterPassword);
      setImportMessage(itemLabels.importSuccess.replace("{count}", String(count)));
      await refreshItems();
    } catch (err) {
      setListError(formatTauriError(err));
    }
  }

  return (
    <section className="ps-main" aria-labelledby="main-heading">
      <div className="ps-card ps-card--toolbar">
        <h2 className="visually-hidden" id="main-heading">
          {desktopLabels.mainHiddenTitle}
        </h2>
        <div className="ps-toolbar">
          <input
            className="ps-input"
            type="search"
            placeholder={itemLabels.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => void handleSearchChange(event.target.value)}
          />
          <button type="button" className="ps-button ps-button--secondary" onClick={() => fileInputRef.current?.click()}>
            {itemLabels.importCsv}
          </button>
          <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleExportCsv()}>
            {itemLabels.exportCsv}
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => void handleImportFile(event)} />
          <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleLock()}>
            {itemLabels.lock}
          </button>
        </div>
      </div>

      <ItemForm
        mode={editingId ? "edit" : "create"}
        values={formValues}
        labels={itemLabels}
        error={formError}
        onChange={setFormValues}
        onSubmit={(values) => void handleSubmit(values)}
        onCancel={editingId ? resetForm : undefined}
        onGeneratePassword={() => void handleGenerate()}
      />

      <div className="ps-settings-grid">
        <ClipboardClearSettings labels={desktopLabels.clipboard} />
        <BiometricUnlockSettings boxPath={boxPath} masterPassword={masterPassword} />
        <CloudSyncSettings
          localItems={items}
          masterPassword={masterPassword}
          onSynced={() => refreshItems()}
          import1puxSuccess={(count) => itemLabels.import1puxSuccess.replace("{count}", String(count))}
        />
      </div>

      <section className="ps-card ps-card--list" aria-labelledby="item-list-heading">
        <div className="ps-card__header">
          <h3 className="ps-heading-3" id="item-list-heading">
            {itemLabels.listHeading}
          </h3>
          <span className="ps-badge">
            {items.length} {itemLabels.countSuffix}
          </span>
        </div>

        {importMessage ? <StatusMessage message={importMessage} variant="success" /> : null}
        {exportMessage ? <StatusMessage message={exportMessage} variant="success" /> : null}
        {listError ? <StatusMessage message={listError} variant="error" /> : null}

        {loading ? (
          <p className="ps-text-muted">{desktopLabels.loading}</p>
        ) : (
          <ConnectItemList
            items={items}
            labels={itemLabels}
            onEdit={handleEdit}
            onDelete={(id) => void handleDelete(id)}
          />
        )}
      </section>
    </section>
  );
}
