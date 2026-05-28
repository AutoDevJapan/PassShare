import { useEffect, useState } from "react";
import type { ConnectItem } from "@shared/types/item.js";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
import {
  detectSyncConflicts,
  isCloudSyncEnabled,
  setCloudSyncEnabled,
  type SyncConflict,
} from "../lib/cloud-sync";
import { StatusMessage } from "./StatusMessage";

type CloudSyncSettingsProps = {
  localItems: ConnectItem[];
};

export function CloudSyncSettings({ localItems }: CloudSyncSettingsProps) {
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

  useEffect(() => {
    setCloudSyncEnabled(enabled);
  }, [enabled]);

  async function handleCheckSync() {
    if (!enabled) {
      return;
    }
    if (!apiBaseUrl.trim() || !email.trim() || !password || !vaultId.trim()) {
      setMessage(labels.sync.error);
      setMessageVariant("error");
      return;
    }

    setBusy(true);
    setMessage("");
    setConflicts([]);
    try {
      const found = await detectSyncConflicts(
        { apiBaseUrl: apiBaseUrl.trim(), email: email.trim(), password, vaultId: vaultId.trim() },
        localItems,
      );
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
          <button
            type="button"
            className="ps-button ps-button--secondary"
            disabled={busy}
            onClick={() => void handleCheckSync()}
          >
            {labels.sync.run}
          </button>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <ul className="ps-conflict-list">
          {conflicts.map((conflict) => (
            <li key={conflict.itemId}>{labels.sync.conflictItem(conflict.title)}</li>
          ))}
        </ul>
      ) : null}

      {message ? <StatusMessage message={message} variant={messageVariant} /> : null}
    </section>
  );
}
