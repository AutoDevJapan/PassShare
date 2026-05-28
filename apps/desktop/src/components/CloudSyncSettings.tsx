import { useEffect, useRef, useState } from "react";
import type { ConnectItem } from "@shared/types/item.js";
import { formValuesFromItem } from "@shared/types/item.js";
import { import1puxWithSession } from "@shared/lib/1pux-import";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
import {
  checkSyncConflicts,
  isCloudSyncEnabled,
  resolveConflictKeepLocal,
  resolveConflictKeepRemote,
  runCloudSync,
  setCloudSyncEnabled,
  type CloudSyncConfig,
  type SyncConflict,
} from "../lib/cloud-sync";
import { upsertSyncItem } from "../tauri";
import { StatusMessage } from "./StatusMessage";

type CloudSyncSettingsProps = {
  localItems: ConnectItem[];
  masterPassword: string;
  onSynced: () => Promise<void>;
  import1puxSuccess: (count: number) => string;
};

function buildConfig(
  apiBaseUrl: string,
  email: string,
  password: string,
  vaultId: string,
): CloudSyncConfig | null {
  if (!apiBaseUrl.trim() || !email.trim() || !password || !vaultId.trim()) {
    return null;
  }
  return {
    apiBaseUrl: apiBaseUrl.trim(),
    email: email.trim(),
    password,
    vaultId: vaultId.trim(),
  };
}

export function CloudSyncSettings({
  localItems,
  masterPassword,
  onSynced,
  import1puxSuccess,
}: CloudSyncSettingsProps) {
  const labels = useDesktopLabels();
  const [enabled, setEnabled] = useState(isCloudSyncEnabled());
  const [apiBaseUrl, setApiBaseUrl] = useState(import.meta.env.VITE_API_BASE_URL ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [message, setMessage] = useState("");
  const [messageVariant, setMessageVariant] = useState<"info" | "error" | "success">("info");
  const [busy, setBusy] = useState(false);
  const puxInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCloudSyncEnabled(enabled);
  }, [enabled]);

  const config = buildConfig(apiBaseUrl, email, password, vaultId);

  async function pullRemoteItem(item: ConnectItem): Promise<void> {
    await upsertSyncItem({
      id: item.id,
      values: formValuesFromItem(item),
      masterPassword,
    });
  }

  async function handleCheckSync() {
    if (!enabled || !config) {
      return;
    }

    setBusy(true);
    setMessage("");
    setConflicts([]);
    try {
      const found = await checkSyncConflicts(config, localItems);
      setConflicts(found);
      setMessage(found.length === 0 ? labels.sync.noConflict : labels.sync.conflictTitle);
      setMessageVariant(found.length === 0 ? "success" : "info");
    } catch {
      setMessage(labels.sync.error);
      setMessageVariant("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleRunSync() {
    if (!enabled || !config) {
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const result = await runCloudSync(config, localItems, pullRemoteItem);
      setConflicts(result.conflicts);
      await onSynced();
      if (result.conflicts.length > 0) {
        setMessage(labels.sync.conflictTitle);
        setMessageVariant("info");
      } else {
        setMessage(labels.sync.syncSuccess(result.pushed, result.pulled));
        setMessageVariant("success");
      }
    } catch {
      setMessage(labels.sync.error);
      setMessageVariant("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveKeepLocal(conflict: SyncConflict) {
    if (!config) {
      return;
    }
    setBusy(true);
    try {
      await resolveConflictKeepLocal(config, conflict.local);
      setConflicts((current) => current.filter((c) => c.itemId !== conflict.itemId));
      setMessageVariant("success");
    } catch {
      setMessage(labels.sync.error);
      setMessageVariant("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveKeepRemote(conflict: SyncConflict) {
    setBusy(true);
    try {
      await resolveConflictKeepRemote(conflict.remote, pullRemoteItem);
      setConflicts((current) => current.filter((c) => c.itemId !== conflict.itemId));
      await onSynced();
      setMessageVariant("success");
    } catch {
      setMessage(labels.sync.error);
      setMessageVariant("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport1pux(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !config) {
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const result = await import1puxWithSession(
        config.apiBaseUrl,
        config.vaultId,
        file,
        config.email,
        config.password,
      );
      setMessage(import1puxSuccess(result.imported));
      setMessageVariant("success");
    } catch {
      setMessage(labels.sync.error);
      setMessageVariant("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ps-card ps-card--compact" aria-labelledby="cloud-sync-heading">
      <h3 className="ps-heading-3" id="cloud-sync-heading">
        {labels.sync.title}
      </h3>
      <p className="ps-text-muted">{labels.sync.lead}</p>

      <label className="ps-label ps-label--inline">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {labels.sync.enable}
      </label>

      {enabled ? (
        <div className="ps-grid">
          <label className="ps-label">
            {labels.sync.apiUrl}
            <input
              className="ps-input"
              type="url"
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="ps-label">
            {labels.sync.email}
            <input
              className="ps-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="ps-label">
            {labels.sync.password}
            <input
              className="ps-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="ps-label">
            {labels.sync.vaultId}
            <input
              className="ps-input"
              value={vaultId}
              onChange={(event) => setVaultId(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="ps-toolbar">
            <button
              type="button"
              className="ps-button ps-button--secondary"
              disabled={busy || !config}
              onClick={() => void handleCheckSync()}
            >
              {labels.sync.run}
            </button>
            <button
              type="button"
              className="ps-button"
              disabled={busy || !config}
              onClick={() => void handleRunSync()}
            >
              {labels.sync.runSync}
            </button>
            <button
              type="button"
              className="ps-button ps-button--secondary"
              disabled={busy || !config}
              onClick={() => puxInputRef.current?.click()}
            >
              {labels.sync.import1pux}
            </button>
            <input
              ref={puxInputRef}
              type="file"
              accept=".1pux,.zip,application/zip"
              hidden
              onChange={(event) => void handleImport1pux(event)}
            />
          </div>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <ul className="ps-conflict-list">
          {conflicts.map((conflict) => (
            <li key={conflict.itemId} className="ps-conflict-item">
              <span>{labels.sync.conflictItem(conflict.title)}</span>
              <div className="ps-toolbar">
                <button
                  type="button"
                  className="ps-button ps-button--secondary"
                  disabled={busy}
                  onClick={() => void handleResolveKeepLocal(conflict)}
                >
                  {labels.sync.keepLocal}
                </button>
                <button
                  type="button"
                  className="ps-button ps-button--secondary"
                  disabled={busy}
                  onClick={() => void handleResolveKeepRemote(conflict)}
                >
                  {labels.sync.keepRemote}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? <StatusMessage message={message} variant={messageVariant} /> : null}
    </section>
  );
}
