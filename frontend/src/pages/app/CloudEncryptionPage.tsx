import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useI18n } from "@shared/i18n/I18nProvider";
import type { MessageKey } from "@shared/i18n/index";
import { useAuthSession } from "../../hooks/useAuthSession";
import { listVaultMembers } from "../../lib/auth-api";
import { CloudWorker, lockCloudUi, type OwnerContext } from "../../lib/cloud-worker";
import { CloudApiError, bundleText, clearPendingBundle, getBoxState, getOwnerBundle,
  readPendingBundle, sameBundle, savePendingBundle, setupBox, type BoxState } from "../../lib/cloud-api";

function errorKey(error: unknown): MessageKey {
  if (error instanceof CloudApiError) {
    if (error.status === 404) return "cloud.unavailable";
    if (error.status === 403) return "cloud.ownerOnly";
    if (error.code === "PS015") return "cloud.conflict";
    if (error.code === "PS055") return "cloud.notEmpty";
  }
  return "cloud.failed";
}

// Gate before mounting any legacy item component, including while state is unknown.
export function CloudBoxGate({ compatibility, setup = false }: {
  compatibility?: (ensureCompatibility: () => Promise<void>) => ReactNode; setup?: boolean;
}) {
  const { vaultId = "" } = useParams();
  const location = useLocation();
  const { user, connectClient, refreshConnect } = useAuthSession();
  const { t } = useI18n();
  const scope = `${user?.id}:${vaultId}:${setup}:${location.key}`;
  const [result, setResult] = useState<{ scope: string; state?: BoxState; error?: MessageKey }>({ scope: "" });
  const [retry, setRetry] = useState(0);
  const gateRequest = useRef<{ controller: AbortController; scope: string; retry: number; encrypted: boolean; checking: Promise<BoxState> | null } | null>(null);
  const readState = useCallback(async (signal: AbortSignal): Promise<BoxState> => {
    try { return await getBoxState(vaultId, signal); }
    catch (error) {
      // With the feature disabled, the existing metadata endpoint still checks
      // the authoritative DB boundary and rejects encrypted boxes with 409.
      // A 404 alone never proves compatibility. No legacy item is requested.
      if (!(error instanceof CloudApiError) || error.status !== 404 || setup || !compatibility || !connectClient) throw error;
      signal.throwIfAborted();
      await connectClient.getVault(vaultId);
      signal.throwIfAborted();
      return { mode: "compatibility", keyEpoch: null };
    }
  }, [vaultId, setup, !!compatibility, connectClient]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    const request: NonNullable<typeof gateRequest.current> = { controller, scope, retry, encrypted: false, checking: null };
    gateRequest.current = request;
    if (user && vaultId) {
      request.checking = readState(controller.signal).finally(() => { request.checking = null; });
      void request.checking.then(
      (state) => {
        if (!controller.signal.aborted) {
          if (state.mode === "encrypted") request.encrypted = true;
          if (state.mode === "encrypted" || !request.encrypted) setResult({ scope, state });
        }
      },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ scope, error: errorKey(error) }); },
      );
    }
    return () => { controller.abort(); gateRequest.current = null; };
  }, [scope, user?.id, vaultId, retry, readState]);
  const ensureCompatibility = useCallback(async () => {
    const request = gateRequest.current;
    if (!request || request.scope !== scope || request.retry !== retry || request.encrypted) throw new CloudApiError(409);
    const controller = request.controller;
    controller.signal.throwIfAborted();
    request.checking ??= readState(controller.signal).finally(() => { request.checking = null; });
    const state = await request.checking;
    controller.signal.throwIfAborted();
    if (state.mode !== "compatibility") {
      request.encrypted = true;
      setResult({ scope, state });
      throw new CloudApiError(409);
    }
    // A concurrent older compatibility response must not undo an observed switch.
    if (request.encrypted) throw new CloudApiError(409);
  }, [scope, vaultId, retry, readState]);
  if (result.scope !== scope || (!result.state && !result.error)) return <p role="status">{t("session.loading")}</p>;
  if (result.error) return <section className="app-page cloud-page"><p className="ps-error" role="alert">{t(result.error)}</p>
    <button className="ps-button ps-button--secondary" onClick={() => {
      setResult({ scope: "" });
      void refreshConnect().finally(() => setRetry((v) => v + 1));
    }}>{t("cloud.retry")}</button>
    <Link className="app-back-link" to="/app/vaults">{t("app.vault.back")}</Link></section>;
  if (result.state?.mode === "compatibility" && compatibility && !setup) return <>{compatibility(ensureCompatibility)}</>;
  return <CloudEncryptionScreen key={scope} boxId={vaultId} initialState={result.state!} />;
}

export function CloudEncryptionPage() { return <CloudBoxGate setup />; }

function CloudEncryptionScreen({ boxId, initialState }: { boxId: string; initialState: BoxState }) {
  const { user, connectClient, logout } = useAuthSession();
  const { t } = useI18n();
  const ownerId = user?.id ?? "";
  const [name, setName] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [state, setState] = useState(initialState);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [hasPending, setHasPending] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const worker = useRef<CloudWorker | null>(null);
  const operation = useRef<{ controller: AbortController; password: string } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const logoutPending = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const isSetup = state.mode === "compatibility";

  function clearInputs() {
    if (passwordInput.current) passwordInput.current.value = "";
    if (confirmInput.current) confirmInput.current.value = "";
  }
  function lock() {
    ++generation.current;
    if (operation.current) { operation.current.password = ""; operation.current.controller.abort(); }
    operation.current = null;
    worker.current?.dispose(); worker.current = null;
    clearInputs(); setOpened(false); setBusy(false); setVerifying(false); setError(null);
    setLoggingOut(false);
    setAuthorized(false); setCheckRevision((value) => value + 1);
  }
  useLayoutEffect(() => {
    mounted.current = true;
    lock();
    const background = () => {
      if (document.visibilityState === "hidden") lock();
      else setCheckRevision((value) => value + 1);
    };
    const leave = () => lock();
    document.addEventListener("visibilitychange", background);
    window.addEventListener("pagehide", leave);
    window.addEventListener("popstate", leave);
    window.addEventListener("passshare:cloud-lock", leave);
    return () => {
      mounted.current = false;
      lock();
      document.removeEventListener("visibilitychange", background);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("popstate", leave);
      window.removeEventListener("passshare:cloud-lock", leave);
    };
  }, [boxId, ownerId]);

  useEffect(() => {
    let cancelled = false;
    const token = generation.current;
    const active = () => !cancelled && mounted.current && token === generation.current &&
      !logoutPending.current && document.visibilityState !== "hidden";
    setAuthorized(false);
    if (!connectClient || !ownerId || document.visibilityState === "hidden") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const members = await listVaultMembers(boxId, controller.signal);
        if (!active()) return;
        if (!members.some((m) => m.userId === ownerId && m.role === "owner")) {
          setError("cloud.ownerOnly"); return;
        }
        // Metadata only; never request legacy items for an encrypted box.
        const box = isSetup ? await connectClient.getVault(boxId)
          : (await connectClient.listVaults().catch(() => [])).find((candidate) => candidate.id === boxId);
        if (!active()) return;
        if (isSetup && (!box || box.items !== 0)) { setError("cloud.notEmpty"); return; }
        setName(box?.name ?? boxId);
        setHasPending(!!readPendingBundle(ownerId, boxId));
        setAuthorized(true);
      } catch (error) { if (active()) setError(errorKey(error)); }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [boxId, ownerId, connectClient, isSetup, checkRevision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current || !authorized || !connectClient || logoutPending.current || opened || document.visibilityState === "hidden") { clearInputs(); return; }
    const mismatch = isSetup && passwordInput.current?.value !== confirmInput.current?.value;
    const task = { controller: new AbortController(), password: passwordInput.current?.value ?? "" };
    clearInputs(); setError(null);
    if (mismatch) { task.password = ""; setError("cloud.mismatch"); return; }
    const token = ++generation.current;
    const active = () => mounted.current && generation.current === token && !task.controller.signal.aborted &&
      document.visibilityState !== "hidden";
    const startWorker = () => {
      const next = new CloudWorker();
      worker.current = next;
      void next.closed.then(() => {
        if (active() && worker.current === next) {
          lock();
          setError("cloud.failed");
        }
      });
      return next;
    };
    operation.current = task;
    setBusy(true);
    try {
      let current = await getBoxState(boxId, task.controller.signal);
      if (!active()) return;
      const context: OwnerContext = { passwordBoxId: boxId, ownerAccountId: ownerId,
        keyEpoch: current.mode === "encrypted" ? current.keyEpoch : 1 };
      // Read even on open: interrupted setup must verify the exact saved bundle.
      const pending = readPendingBundle(ownerId, boxId);
      let expected = pending;
      worker.current?.dispose();
      let cryptoWorker = startWorker();
      await cryptoWorker.ready;
      if (!active()) return;
      if (current.mode === "compatibility") {
        if (!isSetup) throw new CloudApiError(409, "PS015");
        if (pending) {
          await cryptoWorker.unlock(context, bundleText(pending), task.password);
        } else {
          await cryptoWorker.generate(context);
          if (!active()) return;
          const wrapped = await cryptoWorker.wrap(task.password);
          if (!active()) return;
          expected = JSON.parse(wrapped);
        }
        if (!active() || !expected) return;
        // Only Rust-produced or Rust-unlocked encrypted bundles may reach storage/HTTP.
        savePendingBundle(ownerId, boxId, expected);
        setHasPending(true);
        await setupBox(boxId, expected, task.controller.signal);
        if (!active()) return;
        cryptoWorker.dispose(); worker.current = null;
        current = await getBoxState(boxId, task.controller.signal);
        if (!active()) return;
        if (current.mode !== "encrypted" || current.keyEpoch !== 1) throw new CloudApiError(409, "PS015");
        setState(current);
        setVerifying(true);
        cryptoWorker = startWorker();
      }
      const saved = await getOwnerBundle(boxId, task.controller.signal);
      if (!active()) return;
      if (current.mode !== "encrypted") throw new CloudApiError(409, "PS015");
      if (expected && (saved.bundleVersion !== 1 || !sameBundle(saved.bundle, expected))) throw new CloudApiError(409, "PS015");
      await cryptoWorker.unlock({ ...context, keyEpoch: current.keyEpoch }, bundleText(saved.bundle), task.password);
      task.password = "";
      if (!active()) return;
      // Read-back unlock, not a successful HTTP mutation, is the success boundary.
      if (expected) clearPendingBundle(ownerId, boxId, expected);
      setHasPending(false);
      setState(current); setOpened(true); setVerifying(false);
    } catch (error) {
      if (!active()) return;
      worker.current?.dispose(); worker.current = null;
      setOpened(false); setError(errorKey(error));
    } finally {
      task.password = "";
      if (active()) { operation.current = null; setBusy(false); setVerifying(false); }
    }
  }

  async function handleLogout() {
    if (logoutPending.current) return;
    logoutPending.current = true;
    lockCloudUi();
    const request = logout();
    const token = generation.current;
    setLoggingOut(true);
    try { await request; }
    catch { if (mounted.current && generation.current === token) setError("cloud.logoutFailed"); }
    finally {
      logoutPending.current = false;
      if (mounted.current && generation.current === token) setLoggingOut(false);
    }
  }

  return <section className="app-page cloud-page">
    <Link className="app-back-link" to="/app/vaults">{t("app.vault.back")}</Link>
    <h1 className="cloud-page__heading">{t(isSetup ? "cloud.setupTitle" : "cloud.openTitle")}</h1>
    <div className="cloud-card">
      <h2 className="ps-heading-3">{name || t("app.nav.vaults")}</h2>
      <p>{t(isSetup ? "cloud.setupLead" : "cloud.openLead")}</p>
      <p className="cloud-note">{t("cloud.crudPending")}</p>
      {opened ? <div className="cloud-opened">
        <p className="app-success" role="status">{t("cloud.opened")}</p>
        <button type="button" className="ps-button cloud-submit" onClick={lock}>{t("cloud.lock")}</button>
      </div> : <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <label className="ps-label" htmlFor="cloud-password">{t("cloud.password")}</label>
        <input id="cloud-password" ref={passwordInput} className="ps-input" type="password" autoComplete="off"
          autoCapitalize="none" spellCheck={false}
          required disabled={busy || !authorized} aria-describedby="cloud-explanation cloud-recovery" />
        {isSetup && <><label className="ps-label" htmlFor="cloud-confirmation">{t("cloud.confirmation")}</label>
          <input id="cloud-confirmation" ref={confirmInput} className="ps-input" type="password" autoComplete="off"
            autoCapitalize="none" spellCheck={false}
            required disabled={busy || !authorized} /></>}
        <p id="cloud-explanation">{t("cloud.separate")}</p>
        <p className="cloud-note">{t("cloud.passwordHint")}</p>
        {hasPending && <p className="cloud-note" role="status">{t("cloud.pending")}</p>}
        <button className="ps-button cloud-submit" type="submit" disabled={busy || !authorized}>
          {t(busy ? (verifying ? "cloud.verifying" : "cloud.working") : isSetup ? "cloud.setupSubmit" : "cloud.openSubmit")}</button>
        {busy && <button className="ps-button ps-button--secondary" type="button" onClick={lock}>{t("cloud.lock")}</button>}
      </form>}
      <p className="cloud-note">{t("cloud.neverSent")}</p>
      <p id="cloud-recovery" className="cloud-note">{t("cloud.recovery")}</p>
      {error && <p className="ps-error" role="alert">{t(error)}</p>}
      <button type="button" className="cloud-logout" disabled={loggingOut} onClick={() => void handleLogout()}>{t("session.logout")}</button>
    </div>
  </section>;
}
