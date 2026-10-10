import { useLayoutEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import type { MessageKey } from "@shared/i18n/index";
import { useAuthSession } from "../../hooks/useAuthSession";
import { AuthApiError, listVaultMembers } from "../../lib/auth-api";
import { CloudWorker, lockCloudUi, type ItemContext, type OwnerContext } from "../../lib/cloud-worker";
import { CloudApiError, bundleText, getBoxState, getEncryptedItem, getOwnerBundle,
  listEncryptedItems, publicOwnerBundle, putOwnerBundle, sameBundle, type OwnerBundle } from "../../lib/cloud-api";

const rows: CSSProperties = { display: "grid", gap: ".85rem", minWidth: 0 };
const inputRow: CSSProperties = { ...rows, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))", alignItems: "center" };
const buttons: CSSProperties = { display: "flex", flexWrap: "wrap", gap: ".85rem" };

async function checkOwner(scope: OwnerContext, signal: AbortSignal, assertActive: () => void) {
  const state = await getBoxState(scope.passwordBoxId, signal);
  assertActive();
  if (state.mode !== "encrypted" || state.keyEpoch !== scope.keyEpoch) throw new CloudApiError(409, "PS056");
  const members = await listVaultMembers(scope.passwordBoxId, signal).catch((error: unknown) => {
    if (error instanceof AuthApiError) {
      if (error.code === "PS024" || error.code === "PS026") throw new CloudApiError(401, error.code);
      if (error.code === "PS016" || error.code === "PS032") throw new CloudApiError(403, error.code);
    }
    throw error;
  });
  assertActive();
  if (!members.some((member) => member.userId === scope.ownerAccountId && member.role === "owner")) throw new CloudApiError(403);
}

// This panel never owns or disposes the parent's opened worker or item draft.
export function CloudRecoveryBackup({ worker, scope }: { worker: CloudWorker; scope: OwnerContext }) {
  const { t } = useI18n();
  const { user } = useAuthSession();
  const location = useLocation();
  const [visible, setVisible] = useState(false);
  const [material, setMaterial] = useState<{ code: string; bundle: OwnerBundle } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const current = useRef({ worker, userId: user?.id, location: location.key });
  current.current = { worker, userId: user?.id, location: location.key };
  function clear() {
    ++generation.current;
    operation.current?.abort(); operation.current = null;
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
    setMaterial(null); setConfirmed(false); setDownloaded(false); setBusy(false); setError(null); setVisible(false);
  }
  useLayoutEffect(() => {
    clear();
    let alive = true;
    const hidden = () => { if (document.visibilityState === "hidden") clear(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", clear);
    window.addEventListener("popstate", clear);
    window.addEventListener("passshare:cloud-lock", clear);
    void worker.closed.then(() => { if (alive) clear(); });
    return () => {
      alive = false; clear();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("popstate", clear);
      window.removeEventListener("passshare:cloud-lock", clear);
    };
  }, [worker, scope.passwordBoxId, scope.ownerAccountId, scope.keyEpoch, user?.id, location.key]);
  async function generate() {
    if (operation.current || document.visibilityState === "hidden" || user?.id !== scope.ownerAccountId) return;
    const controller = new AbortController();
    operation.current = controller;
    const timeout = setTimeout(() => { controller.abort(); clear(); }, 60_000);
    const token = ++generation.current;
    const active = () => generation.current === token && !controller.signal.aborted && current.current.worker === worker &&
      current.current.userId === scope.ownerAccountId && current.current.location === location.key && document.visibilityState !== "hidden";
    const assertActive = () => { if (!active()) throw new DOMException("Inactive", "AbortError"); };
    setVisible(true); setBusy(true); setError(null);
    let text = "";
    let transfer: { format: number; recoveryCode: string; bundle: OwnerBundle } | null = null;
    try {
      await checkOwner(scope, controller.signal, assertActive);
      assertActive();
      text = await worker.createRecoveryMaterial();
      assertActive();
      transfer = JSON.parse(text);
      text = "";
      if (!transfer || transfer.format !== 1 || typeof transfer.recoveryCode !== "string" ||
        Object.keys(transfer).sort().join(",") !== "bundle,format,recoveryCode") throw new CloudApiError(502);
      const bundle = publicOwnerBundle(transfer.bundle);
      setMaterial({ code: transfer.recoveryCode, bundle });
    } catch (error) {
      if (!active()) return;
      if (error instanceof CloudApiError && (error.status === 401 || error.status === 403 || error.code === "PS056")) lockCloudUi();
      else setError("cloudRecovery.backupFailed");
    } finally {
      clearTimeout(timeout);
      text = "";
      if (transfer) transfer.recoveryCode = "";
      transfer = null;
      if (active()) { operation.current = null; setBusy(false); }
    }
  }
  function download() {
    if (!material || document.visibilityState === "hidden") return;
    const url = URL.createObjectURL(new Blob([bundleText(material.bundle)], { type: "application/json" }));
    urls.current.add(url);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "passshare-recovery.json";
    anchor.click();
    setDownloaded(true);
    setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 0);
  }
  if (!visible) return <button type="button" className="ps-button ps-button--secondary" onClick={() => void generate()}>{t("cloudRecovery.backupTitle")}</button>;
  return <section style={rows} aria-labelledby="cloud-backup-title" aria-busy={busy}>
    <h2 id="cloud-backup-title" className="ps-heading-3">{t("cloudRecovery.backupTitle")}</h2>
    <p>{t("cloudRecovery.backupLead")}</p>
    {busy && <p role="status">{t("cloud.working")}</p>}
    {material && <>
      <button type="button" className="ps-button cloud-submit" onClick={download}>{t("cloudRecovery.download")}</button>
      <label className="ps-label" htmlFor="cloud-backup-code">{t("cloudRecovery.code")}</label>
      <input id="cloud-backup-code" className="ps-input" value={material.code} readOnly autoComplete="off" spellCheck={false}
        aria-describedby="cloud-backup-note" style={{ fontFamily: "monospace" }} />
      <p id="cloud-backup-note" className="cloud-note">{t("cloudRecovery.codeNote")}</p>
      <label className="ps-label" style={{ display: "flex", gap: ".75rem", alignItems: "center" }}>
        <input type="checkbox" checked={confirmed} disabled={!downloaded} onChange={(event) => setConfirmed(event.target.checked)} />
        {t("cloudRecovery.separateStored")}
      </label>
    </>}
    {error && <p className="ps-error" role="alert">{t(error)}</p>}
    <button type="button" className="ps-button ps-button--secondary" disabled={!!material && !confirmed} onClick={clear}>{t("cloudRecovery.close")}</button>
    {material && !confirmed && <button type="button" className="ps-button ps-button--secondary" onClick={clear}>{t("cloudRecovery.discard")}</button>}
  </section>;
}

type Prepared = { bundle: OwnerBundle; previous: OwnerBundle; version: number; sent: boolean; uncertain: boolean };
type Task = { controller: AbortController; code: string; password: string; login: string; worker: CloudWorker | null };
type Session = { alive: boolean; generation: number; task: Task | null; prepared: Prepared | null;
  outcome: "none" | "unknown" | "retry" | "rejected" | "conflict" | "saved"; error: MessageKey | null };

export function CloudRecoveryPanel({ scope, visible, onCancel, onComplete }: {
  scope: OwnerContext; visible: boolean; onCancel: () => void; onComplete: () => void;
}) {
  const { t } = useI18n();
  const { user } = useAuthSession();
  const location = useLocation();
  const session = useMemo<Session>(() => ({ alive: true, generation: 0, task: null, prepared: null, outcome: "none", error: null }),
    [scope.passwordBoxId, scope.ownerAccountId, scope.keyEpoch, location.key]);
  const [, redraw] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const login = useRef<HTMLInputElement>(null);
  const current = useRef({ session, userId: user?.id, visible });
  current.current = { session, userId: user?.id, visible };
  const changed = () => redraw((revision) => revision + 1);
  function clearInputs() {
    for (const input of [file, code, password, confirmation, login]) if (input.current) input.current.value = "";
  }
  function stop(discard: boolean) {
    ++session.generation;
    const task = session.task;
    if (task) {
      task.code = ""; task.password = ""; task.login = "";
      task.controller.abort(); task.worker?.dispose(); task.worker = null;
      if (session.prepared?.sent) { session.prepared.uncertain = true; session.outcome = "unknown"; }
    }
    clearInputs();
    if (discard) { session.prepared = null; session.outcome = "none"; session.error = null; }
    changed();
  }
  useLayoutEffect(() => {
    session.alive = true;
    const leave = () => { stop(true); onCancel(); };
    const hidden = () => { if (document.visibilityState === "hidden") leave(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    window.addEventListener("popstate", leave);
    window.addEventListener("passshare:cloud-lock", leave);
    return () => {
      session.alive = false; stop(true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("popstate", leave);
      window.removeEventListener("passshare:cloud-lock", leave);
    };
  }, [session, user?.id]);
  useLayoutEffect(() => { if (!visible) stop(false); }, [visible]);

  async function run(event: FormEvent<HTMLFormElement>, retry = false) {
    event.preventDefault();
    if (!visible || !session.alive || session.task || user?.id !== scope.ownerAccountId || document.visibilityState === "hidden") return;
    if (session.outcome === "conflict" || (retry && session.outcome !== "retry")) return;
    if (password.current?.value !== confirmation.current?.value) { clearInputs(); session.error = "cloud.mismatch"; changed(); return; }
    const selected = file.current?.files?.[0];
    const task: Task = { controller: new AbortController(), code: code.current?.value ?? "",
      password: password.current?.value ?? "", login: login.current?.value ?? "", worker: null };
    clearInputs();
    session.task = task; session.error = null;
    // HTTP may outlive the temporary worker. Bound each whole attempt too;
    // preserve a sent envelope as uncertain while clearing credential refs.
    const timeout = setTimeout(() => {
      if (session.task !== task) return;
      stop(false);
      if (session.prepared?.sent) { session.prepared.uncertain = true; session.outcome = "unknown"; }
      session.error = session.prepared?.sent ? "cloudRecovery.unknown" : "cloudRecovery.failed";
      session.task = null;
      changed();
    }, 120_000);
    const token = ++session.generation;
    const active = () => session.alive && current.current.session === session && current.current.userId === scope.ownerAccountId &&
      current.current.visible && session.generation === token && !task.controller.signal.aborted && document.visibilityState !== "hidden";
    const assertActive = () => { if (!active()) throw new DOMException("Inactive", "AbortError"); };
    const signal = task.controller.signal;
    const startWorker = async () => {
      assertActive();
      const worker = new CloudWorker(); task.worker = worker;
      void worker.closed.then(() => {
        if (active() && task.worker === worker) { stop(false); session.error = "cloudRecovery.failed"; changed(); }
      });
      await worker.ready; assertActive();
      return worker;
    };
    const closeWorker = () => { const worker = task.worker; task.worker = null; worker?.dispose(); };
    // No plaintext DTO is projected or rendered; Rust validates the full item.
    const verifyItems = async (worker: CloudWorker) => {
      let after: string | null = null;
      const ids = new Set<string>();
      do {
        const page = await listEncryptedItems(scope.passwordBoxId, scope.keyEpoch, after, signal);
        assertActive();
        for (const item of page.items) {
          if (ids.has(item.itemId)) throw new CloudApiError(502);
          ids.add(item.itemId);
          const context: ItemContext = { ...item, passwordBoxId: scope.passwordBoxId };
          let envelope = "";
          try {
            envelope = await getEncryptedItem(context, signal); assertActive();
            await worker.decrypt(envelope, context); assertActive();
          } finally { envelope = ""; }
        }
        after = page.nextCursor;
      } while (after !== null);
    };
    const readBack = async (prepared: Prepared) => {
      await checkOwner(scope, signal, assertActive); assertActive();
      const saved = await getOwnerBundle(scope.passwordBoxId, signal); assertActive();
      if (saved.bundleVersion === prepared.version + 1 && sameBundle(saved.bundle, prepared.bundle)) {
        session.outcome = "saved"; changed();
        return saved;
      }
      if (saved.bundleVersion === prepared.version && sameBundle(saved.bundle, prepared.previous)) {
        session.outcome = "retry"; session.error = "cloudRecovery.retryNote"; changed(); return null;
      }
      session.outcome = "conflict";
      throw new CloudApiError(409, "PS015");
    };
    changed();
    let fileText = "", wrapped = "";
    try {
      await checkOwner(scope, signal, assertActive); assertActive();
      if (!session.prepared) {
        if (!selected || selected.size === 0 || selected.size > 4096) { session.error = "cloudRecovery.fileInvalid"; return; }
        fileText = await selected.text(); assertActive();
        const bundle = publicOwnerBundle(JSON.parse(fileText)); fileText = "";
        const previous = await getOwnerBundle(scope.passwordBoxId, signal); assertActive();
        const worker = await startWorker(); assertActive();
        await worker.recover(scope, bundleText(bundle), task.code); task.code = ""; assertActive();
        await verifyItems(worker); assertActive();
        await checkOwner(scope, signal, assertActive); assertActive();
        wrapped = await worker.wrap(task.password); assertActive();
        const next = publicOwnerBundle(JSON.parse(wrapped)); wrapped = "";
        session.prepared = { bundle: next, previous: previous.bundle, version: previous.bundleVersion, sent: false, uncertain: false };
        closeWorker();
      }
      const prepared = session.prepared;
      task.code = "";
      let saved = await readBack(prepared); assertActive();
      if (!saved && (retry || !prepared.sent)) {
        // Verify re-entered passwords against the exact prepared bundle before
        // any replay. This never wraps again or changes the pending ciphertext.
        const check = await startWorker(); assertActive();
        await check.unlock(scope, bundleText(prepared.bundle), task.password); assertActive();
        await verifyItems(check); assertActive();
        closeWorker();
        await checkOwner(scope, signal, assertActive); assertActive();
        // Repeat only the sealed material prepared once by Rust, with its CAS.
        prepared.sent = true;
        try {
          await putOwnerBundle(scope.passwordBoxId, prepared.version, prepared.bundle, task.login, signal);
          task.login = ""; assertActive();
        } catch (error) {
          task.login = ""; assertActive();
          const rejected = error instanceof CloudApiError && error.status >= 400 && error.status < 500;
          if (rejected) {
            if (error.status === 409) session.outcome = "conflict";
            else session.outcome = prepared.uncertain ? "unknown" : "rejected";
            throw error;
          }
          prepared.uncertain = true; session.outcome = "unknown";
          saved = await readBack(prepared); assertActive();
          if (!saved) return;
        }
        saved ??= await readBack(prepared); assertActive();
      }
      if (!saved) return;
      session.error = null;
      // A saved envelope alone is insufficient. Reopen on a fresh Rust worker.
      closeWorker();
      const worker = await startWorker(); assertActive();
      await worker.unlock(scope, bundleText(saved.bundle), task.password); task.password = ""; assertActive();
      await verifyItems(worker); assertActive();
      await checkOwner(scope, signal, assertActive); assertActive();
      const final = await getOwnerBundle(scope.passwordBoxId, signal); assertActive();
      if (final.bundleVersion !== saved.bundleVersion || !sameBundle(final.bundle, prepared.bundle)) throw new CloudApiError(409, "PS015");
      session.prepared = null; session.outcome = "none";
      closeWorker(); onComplete();
    } catch (error) {
      if (!active()) return;
      if (error instanceof CloudApiError && (error.status === 401 || error.status === 403 || error.code === "PS056")) {
        lockCloudUi(); return;
      }
      if (error instanceof CloudApiError && error.status === 409) session.outcome = "conflict";
      session.error = session.outcome === "conflict" ? "cloudRecovery.conflict" : session.outcome === "unknown" ? "cloudRecovery.unknown" :
        session.outcome === "rejected" ? "cloudRecovery.rejected" : session.outcome === "saved" ? "cloudRecovery.verifyFailed" : "cloudRecovery.failed";
    } finally {
      clearTimeout(timeout);
      task.code = ""; task.password = ""; task.login = ""; fileText = ""; wrapped = ""; closeWorker();
      if (session.task === task) session.task = null;
      if (session.alive && current.current.session === session) changed();
    }
  }
  if (!visible) return null;
  const busy = !!session.task;
  const prepared = !!session.prepared;
  const blocked = session.outcome === "conflict";
  return <section style={rows} aria-label={t("cloudRecovery.title")}>
    <form onSubmit={(event) => {
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      void run(event, submitter instanceof HTMLButtonElement && submitter.name === "retry");
    }} aria-busy={busy}>
      <div style={inputRow}><label className="ps-label" htmlFor="cloud-recovery-file">{t("cloudRecovery.file")}</label>
        <input ref={file} id="cloud-recovery-file" className="ps-input" type="file" accept=".json,application/json" required={!prepared}
          disabled={busy || prepared || blocked} aria-describedby="cloud-recovery-file-note" /></div>
      <p id="cloud-recovery-file-note" className="cloud-note">{t("cloudRecovery.fileNote")}</p>
      <div style={inputRow}><label className="ps-label" htmlFor="cloud-recovery-code">{t("cloudRecovery.code")}</label>
        <input ref={code} id="cloud-recovery-code" className="ps-input" autoComplete="off" autoCapitalize="none" spellCheck={false}
          required={!prepared} disabled={busy || prepared || blocked} /></div>
      <div style={inputRow}><label className="ps-label" htmlFor="cloud-recovery-password">{t("cloudRecovery.newPassword")}</label>
        <input ref={password} id="cloud-recovery-password" className="ps-input" type="password" autoComplete="off" autoCapitalize="none"
          spellCheck={false} required disabled={busy || blocked} aria-describedby="cloud-recovery-password-note" /></div>
      <div style={inputRow}><label className="ps-label" htmlFor="cloud-recovery-confirmation">{t("cloud.confirmation")}</label>
        <input ref={confirmation} id="cloud-recovery-confirmation" className="ps-input" type="password" autoComplete="off" autoCapitalize="none"
          spellCheck={false} required disabled={busy || blocked} /></div>
      <p id="cloud-recovery-password-note" className="cloud-note">{t(prepared ? "cloudRecovery.preparedPassword" : "cloud.passwordHint")}</p>
      <div style={inputRow}><label className="ps-label" htmlFor="cloud-recovery-login">{t("cloudRecovery.loginPassword")}</label>
        <input ref={login} id="cloud-recovery-login" className="ps-input" type="password" autoComplete="off" autoCapitalize="none"
          spellCheck={false} required disabled={busy || blocked} /></div>
      <p className="cloud-note">{t("cloudRecovery.separate")}</p>
      <div style={buttons}>
        <button type="submit" className="ps-button cloud-submit" disabled={busy || blocked} style={{ flex: "1 1 15rem", width: "auto" }}>
          {t(busy ? "cloud.working" : prepared ? "cloudRecovery.checkSaved" : "cloudRecovery.submit")}</button>
        <button type="button" className="ps-button ps-button--secondary" onClick={() => { stop(false); onCancel(); }}>{t("cloudRecovery.cancel")}</button>
      </div>
      {session.outcome === "retry" && <button type="submit" name="retry" className="ps-button ps-button--secondary" disabled={busy}>
        {t("cloudRecovery.retrySame")}</button>}
      {blocked && <button type="button" className="ps-button ps-button--secondary" disabled={busy}
        onClick={() => { session.prepared = null; session.outcome = "none"; session.error = null; clearInputs(); changed(); }}>{t("cloudRecovery.restart")}</button>}
      <p className="cloud-note">{t("cloudRecovery.verifyNote")}</p>
      <p className="cloud-note">{t("cloudRecovery.cancelNote")}</p>
      {prepared && <p className="cloud-note" role="status">{t("cloudRecovery.prepared")}</p>}
      {session.error && <p className="ps-error" role="alert">{t(session.error)}</p>}
    </form>
  </section>;
}
