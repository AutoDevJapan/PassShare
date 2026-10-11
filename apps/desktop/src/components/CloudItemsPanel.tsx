import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ConnectClient } from "@passshare/connect";
import { useI18n } from "@shared/i18n/I18nProvider";
import { CloudBoxPanel } from "@shared/cloud/CloudBoxPanel";
import { createCloudSession, type CloudSession } from "@shared/cloud/session-transport";
import { CloudApiError } from "@shared/cloud/cloud-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDesktopLabels } from "../hooks/useDesktopLabels";

// Desktop uses the existing token-session login response (mobile transport).
// Nothing is persisted; .pbox, its recovery and save lifecycle stay independent.
export function CloudItemsPanel() {
  const { t } = useI18n();
  const labels = useDesktopLabels().sync;
  const [session, setSession] = useState<CloudSession | null>(null);
  const [boxes, setBoxes] = useState<Array<{ id: string; name: string }>>([]);
  const [boxId, setBoxId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const nativeFocused = useRef(false);
  const lifetime = useRef(0);
  const alive = useRef(true);
  const binding = useRef<CloudSession | null>(null);
  const request = useRef<AbortController | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const base = useRef<HTMLInputElement>(null);
  const email = useRef<HTMLInputElement>(null);
  function clear() {
    ++lifetime.current; request.current?.abort(); request.current = null;
    binding.current?.dispose(); binding.current = null;
    if (password.current) password.current.value = "";
    setSession(null); setBoxes([]); setBoxId(""); setBusy(false);
  }
  useLayoutEffect(() => {
    alive.current = true;
    let disposed = false, focusRevision = 0;
    const stops: Array<() => void> = [];
    const acceptFocus = (value: boolean) => {
      if (disposed) return;
      nativeFocused.current = value; setFocused(value);
      if (!value) window.dispatchEvent(new Event("passshare:cloud-lock"));
    };
    // Native blur can leave the WebView document visible. Subscribe before the
    // initial snapshot, and never let a delayed snapshot overwrite an event.
    void (async () => {
      try {
        const nativeWindow = getCurrentWindow();
        for (const [event, value] of [["tauri://blur", false], ["tauri://focus", true]] as const) {
          const stop = await nativeWindow.listen(event, () => { ++focusRevision; acceptFocus(value); });
          if (disposed) { stop(); return; }
          stops.push(stop);
        }
        const revision = focusRevision;
        const value = await nativeWindow.isFocused();
        if (revision === focusRevision) acceptFocus(value);
      } catch {
        for (const stop of stops.splice(0)) stop();
        acceptFocus(false);
        if (!disposed) setFailed(true);
      }
    })();
    const background = () => { if (document.visibilityState === "hidden") clear(); };
    window.addEventListener("pagehide", clear);
    window.addEventListener("passshare:cloud-lock", clear);
    document.addEventListener("visibilitychange", background);
    return () => {
      disposed = true; nativeFocused.current = false;
      for (const stop of stops.splice(0)) stop();
      alive.current = false; clear();
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("passshare:cloud-lock", clear);
      document.removeEventListener("visibilitychange", background);
    };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy || !nativeFocused.current) return;
    const generation = ++lifetime.current;
    const controller = new AbortController(); request.current = controller;
    const current = () => alive.current && nativeFocused.current && generation === lifetime.current && !controller.signal.aborted && document.visibilityState !== "hidden";
    let body = JSON.stringify({ email: email.current?.value, password: password.current?.value });
    if (password.current) password.current.value = "";
    setBusy(true); setFailed(false);
    let next: CloudSession | null = null;
    try {
      const url = new URL(base.current?.value ?? "");
      // Validate the same destination as the bounded session transport before login.
      const probe = createCloudSession(url.href, "", ""); probe.dispose();
      const response = await fetch(new URL("/api/auth/login", url), { method: "POST", body, signal: controller.signal,
        credentials: "omit", redirect: "error", cache: "no-store", headers: { "Content-Type": "application/json", "x-passshare-client": "mobile" } });
      body = "";
      if (response.status !== 200) throw new CloudApiError(response.status);
      const auth = await response.json() as { user: { id: string }; refreshToken: string; connectAccessToken: string };
      if (!current()) return;
      next = createCloudSession(url.href, auth.user.id, auth.refreshToken, current);
      binding.current = next;
      const client = new ConnectClient({ host: url.origin, token: auth.connectAccessToken });
      auth.refreshToken = ""; auth.connectAccessToken = "";
      const list = await client.listVaults();
      if (!current()) { next.dispose(); return; }
      binding.current = next; setSession(next); setBoxes(list); setBoxId(list[0]?.id ?? "");
    } catch { next?.dispose(); if (binding.current === next) binding.current = null; if (current()) setFailed(true); }
    finally { body = ""; if (current()) { request.current = null; setBusy(false); } }
  }
  async function logout() {
    const held = binding.current;
    if (held) {
      const response = held.transport("/api/auth/logout", { method: "POST" });
      // Hide and clear key/draft state immediately while formal logout runs.
      setSession(null); setBoxes([]); setBoxId("");
      try { await response; } finally { clear(); }
    } else clear();
  }
  return <section className="ps-card client-cloud">
    {!session ? <form onSubmit={(event) => void login(event)}>
      <label className="ps-label">{labels.apiUrl}<input className="ps-input" ref={base} type="url" required defaultValue={import.meta.env.VITE_API_BASE_URL ?? ""} disabled={busy} /></label>
      <label className="ps-label">{labels.email}<input className="ps-input" ref={email} type="email" required autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} /></label>
      <label className="ps-label">{labels.password}<input className="ps-input" ref={password} type="password" required autoComplete="current-password" disabled={busy} /></label>
      <button className="ps-button" disabled={busy || !focused}>{t("cloud.openSubmit")}</button>
    </form> : <>
      <label className="ps-label">{labels.vaultId}<select className="ps-input" value={boxId} onChange={(event) => setBoxId(event.target.value)}>
        {boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
      </select></label>
      <button type="button" className="ps-button ps-button--secondary" onClick={() => void logout().catch(() => setFailed(true))}>{t("session.logout")}</button>
      {boxId && <CloudBoxPanel key={boxId} session={session} boxId={boxId} split />}
    </>}
    {failed && <p className="ps-error" role="alert">{t("cloud.failed")}</p>}
  </section>;
}
