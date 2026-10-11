import { useI18n } from "@shared/i18n/I18nProvider";
import { CloudBoxPanel } from "@shared/cloud/CloudBoxPanel";
import { useEffect, useMemo, useState, useRef } from "react";
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
  const { cloudSession, connectClient } = useAuthSession();
  const { t } = useI18n();
  const [boxes, setBoxes] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setBoxes([]); setSelected(""); setFailed(false);
    if (connectClient) void connectClient.listVaults().then((list) => {
      if (active) { setBoxes(list); setSelected(list[0]?.id ?? ""); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [cloudSession, connectClient]);
  if (!cloudSession) return <p role="status">{t("session.loading")}</p>;
  return <section className="ext-panel">
    <label className="ps-label">{t("app.vault.title")}<select className="ps-input" value={selected} onChange={(event) => setSelected(event.target.value)}>
      {boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
    </select></label>
    {failed && <p role="alert">{t("app.item.loadError")}</p>}
    {selected && <CloudBoxPanel key={`${cloudSession.userId}:${selected}`} session={cloudSession} boxId={selected}
      compatibility={(ensureCompatibility) => <CompatibilityItemsPanel boxId={selected} ensureCompatibility={ensureCompatibility} />} />}
  </section>;
}
function CompatibilityItemsPanel({ boxId, ensureCompatibility }: { boxId: string; ensureCompatibility: () => Promise<void> }) {
  const labels = useExtensionLabels();
  const { connectClient } = useAuthSession();
  const alive = useRef(true);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ConnectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    let active = true;
    void (async () => {
      if (!connectClient) {
        setItems([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        await ensureCompatibility();
        const vaults = [{ id: boxId }];
        const allItems: ConnectItem[] = [];
        for (const vault of vaults) {
          const overviews = await connectClient.listItems(vault.id);
          for (const overview of overviews) {
            const item = await connectClient.getItem(vault.id, overview.id);
            allItems.push(connectItemFromApi(item));
          }
        }
        if (active) setItems(allItems);
      } catch { if (active) setItems([]); } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; alive.current = false; setItems([]); setGenerated(null); };
  }, [connectClient, boxId, ensureCompatibility]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        (item.username ?? "").toLowerCase().includes(needle) ||
        (item.url ?? "").toLowerCase().includes(needle),
    );
  }, [items, query]);

  async function copyValue(label: string, value: string) {
    // Parity with desktop/mobile/web: copy through the shared helper so the
    // secret is wiped from the OS clipboard after the default clear delay
    // instead of lingering indefinitely. The service-worker alarm also covers
    // the popup being closed before the delay elapses.
    await copySecretWithAutoClear(value);
    if (!alive.current) return;
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1500);
  }

  async function handleGeneratePassword() {
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_PASSWORD",
      length: 20,
    });
    if (alive.current && response?.ok && typeof response.password === "string") {
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
                  onClick={() => void copyValue(`${item.id}-user`, item.username ?? "")}
                >
                  {copied === `${item.id}-user` ? labels.copied : labels.copyUsername}
                </button>
              ) : null}
              {item.password ? (
                <button
                  type="button"
                  className="ps-button"
                  onClick={() => void copyValue(`${item.id}-pw`, item.password ?? "")}
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
