import { useEffect, useMemo, useState } from "react";
import type { ConnectItem } from "@shared/types/item.js";
import {
  copyTextWithAutoClear,
  getClipboardClearSeconds,
} from "@shared/ui/clipboard-auto-clear.js";
import { connectItemFromApi } from "../../lib/connect-items";
import { sha256Hex } from "../../lib/hash";
import { useAuthSession } from "../hooks/useAuthSession";
import { useExtensionLabels } from "../hooks/useExtensionLabels";

/**
 * Copy a secret and arm two independent auto-clears:
 *
 *  1. The shared `copyTextWithAutoClear` timer, which clears while the popup
 *     stays open.
 *  2. A service-worker alarm (via `SCHEDULE_CLIPBOARD_CLEAR`) that survives the
 *     popup closing — the common "copy → click page → paste" flow tears the
 *     popup (and its timer) down before the delay elapses. Only a SHA-256 hash
 *     of the secret crosses the message boundary; the plaintext stays here.
 */
async function copySecretWithAutoClear(value: string): Promise<void> {
  const seconds = getClipboardClearSeconds();
  await copyTextWithAutoClear(value, seconds);
  try {
    const hash = await sha256Hex(value);
    await chrome.runtime.sendMessage({
      type: "SCHEDULE_CLIPBOARD_CLEAR",
      hash,
      seconds,
    });
  } catch {
    // Best-effort: if the worker is unreachable the in-popup timer still covers
    // the case where the popup stays open.
  }
}

export function ItemsPanel() {
  const labels = useExtensionLabels();
  const { connectClient } = useAuthSession();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!connectClient) {
        setItems([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const vaults = await connectClient.listVaults();
        const allItems: ConnectItem[] = [];
        for (const vault of vaults) {
          const overviews = await connectClient.listItems(vault.id);
          for (const overview of overviews) {
            const item = await connectClient.getItem(vault.id, overview.id);
            allItems.push(connectItemFromApi(item));
          }
        }
        setItems(allItems);
      } finally {
        setLoading(false);
      }
    })();
  }, [connectClient]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.username.toLowerCase().includes(needle) ||
        (item.url ?? "").toLowerCase().includes(needle),
    );
  }, [items, query]);

  async function copyValue(label: string, value: string) {
    // Parity with desktop/mobile/web: copy through the shared helper so the
    // secret is wiped from the OS clipboard after the default clear delay
    // instead of lingering indefinitely. The service-worker alarm also covers
    // the popup being closed before the delay elapses.
    await copySecretWithAutoClear(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1500);
  }

  async function handleGeneratePassword() {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_PASSWORD",
      length: 20,
    });
    if (response?.ok && typeof response.password === "string") {
      setGenerated(response.password);
      await copySecretWithAutoClear(response.password);
    }
  }

  return (
    <section className="ext-panel">
      <header className="ext-panel__header">
        <h1 className="ps-heading-2">{labels.appTitle}</h1>
      </header>

      <div className="ext-toolbar">
        <input
          className="ps-input"
          type="search"
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleGeneratePassword()}>
          {labels.generatePassword}
        </button>
      </div>

      {generated ? (
        <p className="ext-generated" role="status">
          {labels.generatePassword}: <code>{generated}</code>
        </p>
      ) : null}

      {loading ? <p className="ext-muted">…</p> : null}
      {!loading && filtered.length === 0 ? <p className="ext-muted">{labels.emptyItems}</p> : null}

      <ul className="ext-item-list">
        {filtered.map((item) => (
          <li key={item.id} className="ext-item ps-card">
            <div className="ext-item__title">{item.title}</div>
            {item.username ? <div className="ext-item__meta">{item.username}</div> : null}
            <div className="ext-item__actions">
              {item.username ? (
                <button
                  type="button"
                  className="ps-button ps-button--secondary"
                  onClick={() => void copyValue(`${item.id}-user`, item.username)}
                >
                  {copied === `${item.id}-user` ? labels.copied : labels.copyUsername}
                </button>
              ) : null}
              {item.password ? (
                <button
                  type="button"
                  className="ps-button"
                  onClick={() => void copyValue(`${item.id}-pw`, item.password)}
                >
                  {copied === `${item.id}-pw` ? labels.copied : labels.copyPassword}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
