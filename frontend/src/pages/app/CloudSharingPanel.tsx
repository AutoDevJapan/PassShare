import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@shared/i18n/I18nProvider";
import { listVaultMembers, type VaultMember } from "../../lib/auth-api";
import { CloudWorker, type PublicIdentity, type OwnerContext } from "../../lib/cloud-worker";
import { CloudApiError, getBoxState } from "../../lib/cloud-api";
import { clearPendingIdentity, createIdentity, getIdentity, getMemberIdentity, getSelfGrant, getSnapshot,
  getSnapshotMembers, publicText, putGrant, readOwnPin, readPeerPin, readPendingIdentity,
  savePreparedOwnPin, savePeerPin, savePendingIdentity, type IdentityRecord } from "../../lib/sharing-api";
import "./cloud-sharing.css";

// This component only renders and sequences transport. Rust compares trust
// codes, selects shared context and authenticates the complete item/key data.
export function CloudSharingPanel({ worker, scope, recipient = false, onReceive, onLock }: {
  worker: CloudWorker; scope: OwnerContext; recipient?: boolean;
  onReceive?: () => void; onLock: () => void;
}) {
  const { t } = useI18n();
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [peer, setPeer] = useState("");
  const [trusted, setTrusted] = useState<PublicIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [complete, setComplete] = useState(false);
  const [ownCodeNeeded, setOwnCodeNeeded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [ready, setReady] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const ownCode = useRef<HTMLInputElement>(null);
  const peerCode = useRef<HTMLTextAreaElement>(null);
  const lifetime = useRef(0);
  const task = useRef<{ controller: AbortController; secret: string; code: string } | null>(null);
  const loaded = useRef(false);
  const account = scope.ownerAccountId;
  function clearInputs() {
    for (const ref of [secretInput, confirmation, ownCode]) if (ref.current) ref.current.value = "";
    if (peerCode.current) peerCode.current.value = "";
  }
  function cancel() {
    ++lifetime.current;
    if (task.current) { task.current.secret = ""; task.current.code = ""; task.current.controller.abort(); }
    task.current = null; clearInputs(); setIdentity(null); setTrusted(null); setBusy(false); setComplete(false);
    worker.dispose(); onLock();
  }
  useLayoutEffect(() => {
    const version = ++lifetime.current;
    const controller = new AbortController();
    loaded.current = false;
    setReady(false);
    void (async () => {
      try {
        const record = await getIdentity(controller.signal);
        const list = await listVaultMembers(scope.passwordBoxId, controller.signal);
        if (controller.signal.aborted || lifetime.current !== version || worker.isClosed) return;
        setMembers(list);
        const owner = list.find((m) => m.role === "owner");
        if (recipient) setPeer(owner?.userId ?? "");
        setCreating(!record && !readPendingIdentity(account));
        const pin = readOwnPin(account);
        const held = record ?? readPendingIdentity(account);
        setOwnCodeNeeded(!!held && (!pin || publicText(pin) !== publicText(held.identity)));
        loaded.current = true;
        setReady(true);
      } catch { if (!controller.signal.aborted && lifetime.current === version) setFailed(true); }
    })();
    return () => {
      ++lifetime.current; controller.abort();
      if (task.current) { task.current.controller.abort(); task.current.secret = ""; task.current.code = ""; }
      // The parent owns the supplied worker and terminates it on scope exit.
      // React's development effect replay must not terminate that live handle.
      task.current = null; clearInputs();
    };
  }, [worker, scope.passwordBoxId, account, scope.keyEpoch, recipient]);

  async function flight(action: (current: NonNullable<typeof task.current>, active: () => boolean) => Promise<void>, secret = "", code = "") {
    if (task.current || worker.isClosed || document.visibilityState === "hidden" || !loaded.current) { clearInputs(); return; }
    const current = { controller: new AbortController(), secret, code };
    secret = ""; code = "";
    const version = lifetime.current;
    const active = () => lifetime.current === version && task.current === current && !worker.isClosed && !current.controller.signal.aborted && document.visibilityState !== "hidden";
    task.current = current; setBusy(true); setFailed(false);
    const deadline = setTimeout(() => { if (active()) cancel(); }, 60_000);
    try { await action(current, active); }
    catch (error) {
      if (active()) {
        if (error instanceof CloudApiError && [401, 403].includes(error.status)) cancel();
        else setFailed(true);
      }
    } finally {
      clearTimeout(deadline);
      current.secret = ""; current.code = "";
      if (active()) { task.current = null; setBusy(false); }
    }
  }
  async function unlockIdentity(event: FormEvent) {
    event.preventDefault();
    let secret = secretInput.current?.value ?? "";
    let code = ownCode.current?.value ?? "";
    const mismatch = creating && secret !== confirmation.current?.value;
    clearInputs();
    if (mismatch) { secret = ""; code = ""; setFailed(true); return; }
    const running = flight(async (current, active) => {
      // Serialize initial creation across tabs. Pending retries reuse the same
      // ciphertext, including when PUT committed but its response was lost.
      if (!navigator.locks) throw new CloudApiError(409);
      try { await navigator.locks.request(`passshare.identity-create:${account}`, { signal: current.controller.signal }, async () => {
        if (!active()) return;
        const saved = await getIdentity(current.controller.signal);
        if (!active()) return;
        const pending = readPendingIdentity(account);
        const pin = readOwnPin(account);
        // Another item/recovery transport flight must not turn a caller busy
        // rejection into destruction of the valid box and its current draft.
        if (worker.isBusy) { current.secret = ""; current.code = ""; setFailed(true); return; }
        const prepared = await worker.prepareIdentity(JSON.stringify({
          accountContext: JSON.stringify({ accountId: account, identityVersion: 1 }),
          ownPin: pin ? JSON.stringify(pin) : "", remoteRecord: saved ? JSON.stringify(saved) : "",
          pendingRecord: pending ? JSON.stringify(pending) : "", verificationCode: current.code,
        }), current.secret);
        current.secret = ""; current.code = "";
        if (!active()) return;
        const record = JSON.parse(prepared.record) as IdentityRecord;
        const openedPublic = JSON.parse(prepared.publicIdentity) as PublicIdentity;
        if (prepared.hasPending) savePendingIdentity(account, record);
        savePreparedOwnPin(account, openedPublic);
        if (prepared.requiresCreate) {
          await createIdentity(record, current.controller.signal);
          if (!active()) return;
        }
        if (prepared.hasPending) {
          const readBack = await getIdentity(current.controller.signal);
          if (!active()) return;
          if (!readBack || publicText(readBack) !== publicText(record)) throw new CloudApiError(409);
          clearPendingIdentity(account, record);
        }
        if (active()) setIdentity(openedPublic);
      }); } catch (error) { if (active()) cancel(); throw error; }
    }, secret, code);
    secret = ""; code = "";
    await running;
  }
  async function verifyPeer() {
    let code = peerCode.current?.value ?? "";
    if (peerCode.current) peerCode.current.value = "";
    setTrusted(null); setComplete(false);
    const running = flight(async (current, active) => {
      const descriptor = await getMemberIdentity(scope.passwordBoxId, peer, current.controller.signal);
      if (!active()) return;
      const verified = await worker.verifyPublicIdentity({ accountId: peer, identityVersion: 1 }, JSON.stringify(descriptor), current.code);
      current.code = "";
      if (!active()) return;
      const pin = JSON.parse(verified) as PublicIdentity;
      savePeerPin(account, peer, pin); setTrusted(pin);
    }, "", code);
    code = "";
    await running;
  }
  async function share() {
    if (!identity || !trusted || complete) return;
    await flight(async (current, active) => {
      const state = await getBoxState(scope.passwordBoxId, current.controller.signal);
      if (!active()) return;
      if (state.mode !== "encrypted" || state.keyEpoch !== scope.keyEpoch) { cancel(); return; }
      const descriptor = await getMemberIdentity(scope.passwordBoxId, peer, current.controller.signal);
      if (!active()) return;
      const pin = readPeerPin(account, peer);
      if (!pin || publicText(pin) !== publicText(trusted)) throw new CloudApiError(409);
      try { await worker.verifyPublicIdentity({ accountId: peer, identityVersion: trusted.identityVersion }, JSON.stringify(descriptor), trusted.keyId); }
      catch { if (active()) setTrusted(null); throw new CloudApiError(409); }
      if (!active()) return;
      let revision = 0;
      let selectionMembers;
      if (recipient) {
        const list = await listVaultMembers(scope.passwordBoxId, current.controller.signal);
        if (!active()) return;
        selectionMembers = list.map((m) => ({ accountId: m.userId, role: m.role, membershipConfirmed: m.identityConfirmed === true }));
      } else {
        const snapshot = await getSnapshot(scope.passwordBoxId, current.controller.signal);
        if (!active()) return;
        if (snapshot.keyEpoch !== scope.keyEpoch || snapshot.ownerAccountId !== account) { cancel(); return; }
        const list = await getSnapshotMembers(scope.passwordBoxId, snapshot, current.controller.signal);
        if (!active()) return;
        revision = snapshot.stateRevision;
        selectionMembers = list.map(({ accountId, role, membershipConfirmed }) => ({ accountId, role, membershipConfirmed }));
      }
      const context = await worker.sharingContext(JSON.stringify({ passwordBoxId: scope.passwordBoxId, callerAccountId: account,
        keyEpoch: scope.keyEpoch, sender: recipient ? trusted : identity, recipient: recipient ? identity : trusted, members: selectionMembers }));
      if (!active()) return;
      if (recipient) {
        const envelope = await getSelfGrant(scope.passwordBoxId, context, current.controller.signal);
        if (!active()) return;
        await worker.receiveShared(envelope, JSON.stringify(trusted), context);
        if (active()) onReceive?.();
      } else {
        // Retrying after uncertain HTTP output must reuse the same prepared
        // envelope. Persist ciphertext before sending; no new HPKE randomness.
        const key = `passshare.grant-pending.v1:${account}:${scope.passwordBoxId}:${peer}:${scope.keyEpoch}`;
        if (!navigator.locks) throw new CloudApiError(409);
        await navigator.locks.request(key, { signal: current.controller.signal }, async () => {
          if (!active()) return;
          const prepared = localStorage.getItem(key) ?? await worker.wrapForRecipient(JSON.stringify(trusted), context);
          if (!active()) return;
          if (new TextEncoder().encode(prepared).length > 2048) throw new CloudApiError(409);
          localStorage.setItem(key, prepared);
          if (localStorage.getItem(key) !== prepared) throw new CloudApiError(409);
          const held = JSON.parse(prepared);
          if (publicText(held.context) !== publicText(context)) throw new CloudApiError(409);
          await putGrant(scope.passwordBoxId, revision, context, held, current.controller.signal);
          if (!active()) return;
          if (localStorage.getItem(key) !== prepared) throw new CloudApiError(409);
          localStorage.removeItem(key);
        });
      }
      if (active()) setComplete(true);
    });
  }
  return <section className="cloud-sharing cloud-card" aria-busy={busy || !ready}>
    <h2 className="ps-heading-3">{t("sharing.title")}</h2>
    <p>{t("sharing.lead")}</p>
    {!identity ? <form onSubmit={(event) => void unlockIdentity(event)}>
      <label className="ps-label">{t("sharing.identityPassword")}<input ref={secretInput} className="ps-input" type="password"
        name="identity-secret" required maxLength={1024} autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={busy || !ready} /></label>
      {creating && <label className="ps-label">{t("cloud.confirmation")}<input ref={confirmation} className="ps-input" type="password"
        name="identity-confirmation" required maxLength={1024} autoComplete="off" disabled={busy || !ready} /></label>}
      {ownCodeNeeded && <label className="ps-label">{t("sharing.savedOwnCode")}<input ref={ownCode} className="ps-input"
        name="own-code" required maxLength={256} autoComplete="off" spellCheck={false} disabled={busy || !ready} /></label>}
      <p className="cloud-note">{t("sharing.identitySeparate")}</p>
      <button className="ps-button cloud-submit" disabled={busy || !ready} type="submit">{t("cloud.openSubmit")}</button>
    </form> : <>
      <div className="sharing-step"><h3>{t("sharing.ownCode")}</h3><p>{t("sharing.ownHint")}</p>
        <div className="sharing-own"><code className="sharing-code">{identity.keyId.match(/.{1,4}/g)?.map((group, index) => <span key={index}>{group}</span>)}</code>
        <button className="ps-button ps-button--secondary" type="button" onClick={() => {
          void navigator.clipboard.writeText(identity.keyId).catch(() => setFailed(true));
        }}>{t("sharing.copy")}</button></div></div>
      <div className="sharing-step"><h3>{t("sharing.peerCode")}</h3>
        <label className="ps-label">{t("sharing.peer")}<select className="ps-input" disabled={busy || recipient} value={peer} onChange={(event) => {
          setPeer(event.target.value); setTrusted(null); setComplete(false); if (peerCode.current) peerCode.current.value = "";
        }}><option value="">{t("sharing.selectPeer")}</option>{members.filter((m) => m.userId !== account).map((m) =>
          <option key={m.userId} value={m.userId}>{m.email}</option>)}</select></label>
        <label className="ps-label">{t("sharing.peerHint")}<textarea ref={peerCode} className="ps-input" name="peer-code" maxLength={256}
          autoComplete="off" spellCheck={false} disabled={busy} onInput={() => { setTrusted(null); setComplete(false); }} /></label>
        <div className="sharing-actions"><button className="ps-button" type="button" disabled={busy || !peer} onClick={() => void verifyPeer()}>{t("sharing.verify")}</button>
          <button className="ps-button ps-button--secondary" type="button" onClick={cancel}>{t("sharing.cancel")}</button></div>
      </div>
      <p className="cloud-note">{t(trusted ? "sharing.verified" : "sharing.disabled")}</p>
      <button className="ps-button cloud-submit" type="button" disabled={busy || !trusted || complete} onClick={() => void share()}>{t(recipient ? "cloud.openSubmit" : "sharing.start")}</button>
      {complete && <p role="status">{t("sharing.complete")}</p>}
    </>}
    <p className="cloud-note">{t("sharing.irrevocable")}</p>
    <p className="cloud-note">{t("sharing.rotationPending")}</p>
    {failed && <p className="ps-error" role="alert">{t("sharing.failed")}</p>}
    {!identity && <button className="ps-button ps-button--secondary" type="button" onClick={cancel}>{t("sharing.cancel")}</button>}
  </section>;
}
