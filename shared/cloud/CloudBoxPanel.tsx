import { useLayoutEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";
import type { MessageKey } from "@shared/i18n/index";
import { CloudApiError, type BoxState } from "./cloud-api";
import { CloudWorker, type OwnerContext } from "./cloud-worker";
import type { CloudSession } from "./session-transport";
import { EncryptedItems } from "./EncryptedItems";
import { SharedCloudSharingPanel } from "./CloudSharingPanel";
import "./client-cloud.css";

// Unknown/failed/encrypted state never mounts a legacy item renderer.
export function CloudBoxPanel({ session, boxId, compatibility, split = false }: {
  session: CloudSession; boxId: string; compatibility?: (ensureCompatibility: () => Promise<void>) => ReactNode; split?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<BoxState | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [recipient, setRecipient] = useState<boolean | null>(null);
  const [scope, setScope] = useState<OwnerContext | null>(null);
  const [check, setCheck] = useState(0);
  const lifetime = useRef(0);
  const alive = useRef(false);
  const observedEncrypted = useRef(false);
  const worker = useRef<CloudWorker | null>(null);
  const operation = useRef<{ controller: AbortController; secret: string } | null>(null);
  const checks = useRef(new Set<AbortController>());
  const checkedBinding = useRef<{ session: CloudSession; boxId: string } | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const binding = useRef({ session, boxId });
  binding.current = { session, boxId };
  const active = (generation: number) => alive.current && generation === lifetime.current &&
    binding.current.session === session && binding.current.boxId === boxId && document.visibilityState !== "hidden";
  function lock() {
    ++lifetime.current;
    if (operation.current) { operation.current.secret = ""; operation.current.controller.abort(); }
    operation.current = null;
    for (const controller of checks.current) controller.abort(); checks.current.clear(); checkedBinding.current = null;
    worker.current?.dispose(); worker.current = null;
    if (password.current) password.current.value = "";
    setOpened(false); setScope(null); setRecipient(null); setBusy(false); setError(null); setState(null);
    if (alive.current) setCheck((n) => n + 1);
  }
  useLayoutEffect(() => {
    alive.current = true;
    observedEncrypted.current = false;
    lock();
    const background = () => { if (document.visibilityState === "hidden") lock(); else setCheck((n) => n + 1); };
    window.addEventListener("passshare:cloud-lock", lock);
    window.addEventListener("pagehide", lock);
    document.addEventListener("visibilitychange", background);
    return () => {
      alive.current = false; lock();
      window.removeEventListener("passshare:cloud-lock", lock);
      window.removeEventListener("pagehide", lock);
      document.removeEventListener("visibilitychange", background);
    };
  }, [session, boxId]);
  useLayoutEffect(() => {
    if (document.visibilityState === "hidden") return;
    const generation = lifetime.current;
    const controller = new AbortController();
    checks.current.add(controller);
    void session.api.getBoxState(boxId, controller.signal).then(async (next) => {
      if (!active(generation) || controller.signal.aborted) return;
      if (next.mode === "encrypted") observedEncrypted.current = true;
      else if (observedEncrypted.current) throw new CloudApiError(409, "PS056");
      if (next.mode === "encrypted") {
        const members = await session.listVaultMembers(boxId, controller.signal);
        if (!active(generation) || controller.signal.aborted) return;
        const self = members.find((member) => member.userId === session.userId);
        if (!self || (self.role !== "owner" && self.identityConfirmed !== true)) throw new CloudApiError(403);
        setRecipient(self.role !== "owner");
      }
      checkedBinding.current = { session, boxId };
      setState(next);
    }).catch(() => { if (active(generation) && !controller.signal.aborted) setError("cloud.failed"); })
      .finally(() => checks.current.delete(controller));
    return () => { controller.abort(); checks.current.delete(controller); };
  }, [session, boxId, check]);
  async function ensureCompatibility() {
    const generation = lifetime.current;
    if (!active(generation) || observedEncrypted.current) throw new CloudApiError(409);
    const controller = new AbortController();
    checks.current.add(controller);
    try {
      const next = await session.api.getBoxState(boxId, controller.signal);
      if (!active(generation) || controller.signal.aborted) throw new CloudApiError(401);
      if (next.mode !== "compatibility") { observedEncrypted.current = true; setState(next); throw new CloudApiError(409); }
    } finally { checks.current.delete(controller); }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (busy || worker.current || !state || state.mode !== "encrypted") return;
    const task = { controller: new AbortController(), secret: password.current?.value ?? "" };
    if (password.current) password.current.value = "";
    const generation = ++lifetime.current;
    const controller = task.controller;
    operation.current = task; setBusy(true); setError(null);
    const deadline = setTimeout(() => { if (active(generation)) lock(); }, 60_000);
    try {
      const current = await session.api.getBoxState(boxId, controller.signal);
      if (!active(generation)) return;
      if (current.mode !== "encrypted" || current.keyEpoch !== state.keyEpoch) throw new CloudApiError(409, "PS056");
      const members = await session.listVaultMembers(boxId, controller.signal);
      if (!active(generation)) return;
      const self = members.find((member) => member.userId === session.userId);
      if (!self || (self.role !== "owner" && self.identityConfirmed !== true)) throw new CloudApiError(403);
      const held = { passwordBoxId: boxId, ownerAccountId: session.userId, keyEpoch: state.keyEpoch };
      const crypto = new CloudWorker(); worker.current = crypto;
      void crypto.closed.then(() => { if (active(generation) && worker.current === crypto) lock(); });
      await crypto.ready;
      if (!active(generation)) return;
      if (self.role === "owner") {
        const saved = await session.api.getOwnerBundle(boxId, controller.signal);
        if (!active(generation)) return;
        await crypto.unlock(held, session.api.bundleText(saved.bundle), task.secret);
        task.secret = "";
        if (!active(generation)) return;
        setOpened(true);
      }
      setScope(held); setRecipient(self.role !== "owner");
    } catch (failure) {
      if (active(generation)) { worker.current?.dispose(); worker.current = null; setError(failure instanceof CloudApiError && failure.status === 403 ? "cloud.ownerOnly" : "cloud.failed"); }
    } finally {
      clearTimeout(deadline); task.secret = "";
      if (active(generation)) { operation.current = null; setBusy(false); }
    }
  }
  if (checkedBinding.current?.session !== session || checkedBinding.current.boxId !== boxId) {
    return <section>{error ? <><p role="alert">{t(error)}</p><button type="button" className="ps-button" onClick={lock}>{t("cloud.retry")}</button></> : <p role="status">{t("session.loading")}</p>}</section>;
  }
  if (state?.mode === "compatibility") return <>{compatibility ? compatibility(ensureCompatibility) : <p>{t("cloud.unavailable")}</p>}</>;
  return <section className="cloud-page client-cloud" aria-busy={busy}>
    <header className="encrypted-items-header"><h2>{t("app.item.listHeading")}</h2>
      <button type="button" className="ps-button ps-button--secondary" onClick={lock}>{t("cloud.lock")}</button></header>
    {state?.mode === "encrypted" && scope && worker.current && opened
      ? <EncryptedItems worker={worker.current} scope={scope} userId={session.userId} api={session.api} onLock={lock} split={split} />
      : state?.mode === "encrypted" && scope && worker.current && recipient
        ? <SharedCloudSharingPanel worker={worker.current} scope={scope} recipient api={session.api} sharing={session.sharing}
            listVaultMembers={session.listVaultMembers} onLock={lock} onReceive={() => setOpened(true)} />
        : state?.mode === "encrypted" ? <form onSubmit={(event) => void unlock(event)}>
          <p>{t(recipient ? "sharing.lead" : "cloud.openLead")}</p>
          {!recipient && <label className="ps-label">{t("cloud.password")}<input ref={password} className="ps-input" type="password" required
            autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={1024} disabled={busy} /></label>}
          <button className="ps-button" disabled={busy}>{t("cloud.openSubmit")}</button>
        </form> : !error && <p role="status">{t("session.loading")}</p>}
    {error && <><p className="ps-error" role="alert">{t(error)}</p><button type="button" className="ps-button ps-button--secondary" onClick={lock}>{t("cloud.retry")}</button></>}
  </section>;
}
