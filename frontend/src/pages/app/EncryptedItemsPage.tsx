import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Item } from "@passshare/connect";
import { ItemForm } from "@shared/ui/ItemForm.js";
import { categoryLabel, emptyFormValues, formValuesFromItem, ITEM_CATEGORIES,
  type ConnectItem, type ItemCategory, type ItemFormValues } from "@shared/types/item.js";
import { useI18n } from "@shared/i18n/I18nProvider";
import type { MessageKey } from "@shared/i18n/index";
import { useAuthSession } from "../../hooks/useAuthSession";
import { useItemLabels } from "../../hooks/useItemLabels";
import { connectItemFromApi } from "../../lib/connect-items";
import { CloudApiError, deleteEncryptedItem, getBoxState, getEncryptedItem,
  listEncryptedItems, putEncryptedItem, readItemEnvelope, validateItemContext } from "../../lib/cloud-api";
import type { CloudWorker, ItemContext, OwnerContext } from "../../lib/cloud-worker";
import "./encrypted-items.css";

type Row = { context: ItemContext; originalJSON: string; display: ConnectItem };
type Draft = { original: Row | null; values: ItemFormValues };
type Prepared = { kind: "put"; context: ItemContext; expectedVersion: number; envelopeJSON: string } |
  { kind: "delete"; context: ItemContext };
type Runtime = { alive: boolean; busy: boolean; ready: boolean; rows: Row[]; draft: Draft | null;
  prepared: Prepared | null; deleting: Row | null; outcome: "none" | "unknown" | "conflict" | "rejected";
  error: MessageKey | null; query: string; category: ItemCategory; revealed: boolean;
  controllers: Set<AbortController> };
function runtime(): Runtime {
  return { alive: true, busy: false, ready: false, rows: [], draft: null, prepared: null, deleting: null,
    outcome: "none", error: null, query: "", category: "LOGIN", revealed: false, controllers: new Set() };
}
function clear(runtime: Runtime) {
  runtime.alive = false;
  for (const controller of runtime.controllers) controller.abort();
  runtime.controllers.clear();
  for (const row of runtime.rows) { row.originalJSON = ""; row.display = { ...row.display, title: "", tags: [],
    username: null, password: null, body: null, notes: null, url: null }; }
  if (runtime.draft) runtime.draft.values = emptyFormValues();
  runtime.rows = []; runtime.draft = null; runtime.prepared = null; runtime.deleting = null;
  runtime.query = ""; runtime.revealed = false; runtime.busy = false; runtime.ready = false; runtime.error = null;
}

// The parent supplies an already-unlocked worker and its held, trusted owner
// scope. No Connect credentials, keys, or password inputs enter this component.
export function EncryptedItemsPage({ worker, scope, onLock }: {
  worker: CloudWorker; scope: OwnerContext; onLock: () => void;
}) {
  const { user } = useAuthSession();
  const { t } = useI18n();
  const labels = useItemLabels();
  const { passwordBoxId, ownerAccountId, keyEpoch } = scope;
  const session = useMemo(runtime, [worker, passwordBoxId, ownerAccountId, keyEpoch]);
  const [, redraw] = useState(0);
  const current = useRef({ session, userId: user?.id });
  current.current = { session, userId: user?.id };
  const lockRef = useRef(onLock);
  lockRef.current = onLock;
  const formHost = useRef<HTMLDivElement>(null);
  const changed = () => redraw((revision) => revision + 1);
  const active = (controller?: AbortController) => session.alive && current.current.session === session &&
    current.current.userId === ownerAccountId && !controller?.signal.aborted && document.visibilityState !== "hidden";
  function revoke() { clear(session); changed(); lockRef.current(); }

  function rowFromJSON(originalJSON: string, context: ItemContext): Row {
    // This is a display adapter only. The original worker-validated full JSON is
    // kept verbatim and passed back to Rust for lossless edits.
    const item = JSON.parse(originalJSON) as Item;
    const display = connectItemFromApi(item);
    if (display.id !== context.itemId || item.version !== context.itemVersion ||
      !ITEM_CATEGORIES.includes(display.category)) throw new CloudApiError(502);
    return { context, originalJSON, display };
  }
  async function fail(error: unknown, controller: AbortController) {
    if (!active(controller)) return;
    if (error instanceof CloudApiError && (error.status === 401 || error.status === 403 || error.code === "PS056")) {
      revoke(); return;
    }
    if (error instanceof CloudApiError && error.status === 409) {
      // Check only public mode/epoch; never replace the draft or its original
      // document with a refetched item after a conflict.
      try {
        const state = await getBoxState(passwordBoxId, controller.signal);
        if (!active(controller)) return;
        if (state.mode !== "encrypted" || state.keyEpoch !== keyEpoch) { revoke(); return; }
      } catch { if (active(controller)) revoke(); return; }
      session.outcome = "conflict";
      session.error = "encryptedItems.conflict";
    } else {
      // authFetch's CSRF step can hide an HTTP status behind a generic error.
      // Verify only public scope when available; a network failure still keeps
      // the prepared operation so it can be reconciled without new encryption.
      if (error instanceof CloudApiError && error.status === 0) {
        try {
          const state = await getBoxState(passwordBoxId, controller.signal);
          if (!active(controller)) return;
          if (state.mode !== "encrypted" || state.keyEpoch !== keyEpoch) { revoke(); return; }
        } catch (scopeError) {
          if (!active(controller)) return;
          if (scopeError instanceof CloudApiError && (scopeError.status === 401 || scopeError.status === 403)) { revoke(); return; }
        }
      }
      const rejected = error instanceof CloudApiError && error.status >= 400 && error.status < 500;
      session.outcome = session.prepared ? (rejected ? "rejected" : "unknown") : "none";
      session.error = session.outcome === "unknown" ? "encryptedItems.unknown" : "encryptedItems.failed";
    }
    changed();
  }
  async function oneFlight(action: (controller: AbortController) => Promise<void>) {
    if (!active() || session.busy) return;
    session.busy = true;
    const controller = new AbortController();
    session.controllers.add(controller);
    changed();
    try { await action(controller); }
    catch (error) { await fail(error, controller); }
    finally {
      session.controllers.delete(controller);
      if (active(controller)) { session.busy = false; changed(); }
    }
  }
  async function load(controller: AbortController) {
    if (!active(controller) || session.prepared || session.draft || session.deleting) return;
    session.ready = false; session.error = null; session.outcome = "none";
    session.rows = [];
    changed();
    let after: string | null = null;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    const contexts: ItemContext[] = [];
    do {
      const page = await listEncryptedItems(passwordBoxId, keyEpoch, after, controller.signal);
      if (!active(controller)) return;
      for (const metadata of page.items) {
        if (ids.has(metadata.itemId)) throw new CloudApiError(502);
        ids.add(metadata.itemId);
        contexts.push({ passwordBoxId, itemId: metadata.itemId, itemVersion: metadata.itemVersion, keyEpoch });
      }
      after = page.nextCursor;
      if (after !== null) {
        if (cursors.has(after)) throw new CloudApiError(502);
        cursors.add(after);
      }
    } while (after !== null);
    for (const context of contexts) {
      const envelopeJSON = await getEncryptedItem(context, controller.signal);
      if (!active(controller)) return;
      const originalJSON = await worker.decrypt(envelopeJSON, context);
      if (!active(controller)) return;
      session.rows.push(rowFromJSON(originalJSON, context));
    }
    if (active(controller)) { session.ready = true; changed(); }
  }

  useLayoutEffect(() => {
    // Cleanup runs before paint for changed account, box, epoch, or worker.
    session.alive = true;
    const stop = () => revoke();
    const background = () => { if (document.visibilityState === "hidden") stop(); };
    window.addEventListener("passshare:cloud-lock", stop);
    window.addEventListener("pagehide", stop);
    window.addEventListener("popstate", stop);
    document.addEventListener("visibilitychange", background);
    void worker.closed.then(() => { if (active()) stop(); });
    if (active()) void oneFlight(load);
    return () => {
      clear(session);
      window.removeEventListener("passshare:cloud-lock", stop);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("popstate", stop);
      document.removeEventListener("visibilitychange", background);
    };
  }, [session]);

  async function sendPrepared(controller: AbortController) {
    const prepared = session.prepared;
    if (!prepared || !active(controller) || session.outcome === "conflict" || session.outcome === "rejected") return;
    if (prepared.kind === "delete") {
      await deleteEncryptedItem(prepared.context, controller.signal);
      if (!active(controller)) return;
      session.rows = session.rows.filter((row) => row.context.itemId !== prepared.context.itemId);
      session.deleting = null;
    } else {
      const stored = await putEncryptedItem(prepared.context, prepared.expectedVersion, prepared.envelopeJSON, controller.signal);
      if (!active(controller)) return;
      const originalJSON = await worker.decrypt(stored, prepared.context);
      if (!active(controller)) return;
      const row = rowFromJSON(originalJSON, prepared.context);
      session.rows = [...session.rows.filter((prior) => prior.context.itemId !== row.context.itemId), row]
        .sort((left, right) => left.context.itemId.localeCompare(right.context.itemId));
      session.draft = null;
    }
    session.prepared = null; session.outcome = "none"; session.error = null; session.revealed = false;
    changed();
  }
  function save(values: ItemFormValues) {
    if (!session.ready || !session.draft || session.outcome === "conflict" || session.outcome === "rejected") return;
    void oneFlight(async (controller) => {
      if (!session.prepared) {
        const original = session.draft?.original;
        let context: ItemContext;
        let envelopeJSON: string;
        const completeFormValuesJSON = JSON.stringify(values);
        if (original) {
          if (original.context.itemVersion >= Number.MAX_SAFE_INTEGER) throw new CloudApiError(502);
          context = { ...original.context, itemVersion: original.context.itemVersion + 1 };
          envelopeJSON = await worker.editItem(original.originalJSON, completeFormValuesJSON, context);
        } else {
          envelopeJSON = await worker.createItem(completeFormValuesJSON);
          if (!active(controller)) return;
          const envelope = readItemEnvelope(envelopeJSON);
          // The creation ID is generated by Rust, never by a GET response or UI.
          context = { passwordBoxId, itemId: envelope.context.itemId, itemVersion: 1, keyEpoch };
        }
        if (!active(controller)) return;
        validateItemContext(context);
        readItemEnvelope(envelopeJSON, context);
        session.prepared = { kind: "put", context, expectedVersion: context.itemVersion - 1, envelopeJSON };
      }
      await sendPrepared(controller);
    });
  }
  function cancel() {
    if (!active() || session.busy) return;
    session.draft = null; session.deleting = null; session.revealed = false;
    if (session.outcome === "unknown") {
      // Discard plaintext draft explicitly, but reconcile the outstanding exact
      // operation before allowing another payload or another creation ID.
      changed(); return;
    }
    const conflict = session.outcome === "conflict" || session.outcome === "rejected";
    session.prepared = null; session.outcome = "none"; session.error = null;
    changed();
    if (conflict) void oneFlight(load);
  }
  function startDraft(row: Row | null) {
    if (!active() || session.busy || !session.ready || session.prepared || session.draft || session.deleting) return;
    session.error = null; session.revealed = false;
    session.draft = { original: row, values: row ? formValuesFromItem(row.display) : emptyFormValues(session.category) };
    changed();
  }
  function remove(row: Row) {
    if (!active() || session.busy || !session.ready || session.draft || session.prepared || session.deleting) return;
    session.deleting = row; session.error = null; changed();
  }
  function confirmRemove() {
    if (!session.deleting || session.outcome !== "none") return;
    void oneFlight(async (controller) => {
      session.prepared ??= { kind: "delete", context: { ...session.deleting!.context } };
      await sendPrepared(controller);
    });
  }
  // Ref scope guard applies during render, before layout effects can run.
  if (!active()) return null;
  const blocked = session.busy || !session.ready || !!session.draft || !!session.deleting || !!session.prepared;
  const query = session.query.trim().toLocaleLowerCase();
  const rows = session.ready ? session.rows.filter(({ display }) => display.category === session.category &&
    (!query || [display.title, display.username, display.url, ...display.tags].some((value) => value?.toLocaleLowerCase().includes(query)))) : [];
  return <div className="encrypted-items" aria-busy={session.busy}>
    <p className="app-success" role="status">{t("cloud.opened")}</p>
    <input type="search" className="ps-input" aria-label={labels.searchPlaceholder} placeholder={labels.searchPlaceholder}
      value={session.query} onChange={(event) => { if (active()) { session.query = event.target.value; changed(); } }} />
    <div className="encrypted-items__toolbar">
      <div className="encrypted-items__categories" role="group" aria-label={t("encryptedItems.categories")}>
        {ITEM_CATEGORIES.map((category) => <button key={category} type="button"
          className={`ps-button ${category === session.category ? "ps-button--primary" : "ps-button--secondary"}`}
          aria-pressed={category === session.category} onClick={() => { if (active()) { session.category = category; changed(); } }}>
          {categoryLabel(category, labels)}</button>)}
      </div>
      <button type="button" className="ps-button ps-button--primary" disabled={blocked} onClick={() => startDraft(null)}>{labels.submitAdd}</button>
      <button type="button" className="ps-button ps-button--secondary" disabled={session.busy || !!session.draft || !!session.deleting || !!session.prepared}
        onClick={() => void oneFlight(load)}>{t("app.item.reload")}</button>
    </div>
    {session.busy && <p role="status">{t("cloud.working")}</p>}
    {session.outcome === "unknown" && <button type="button" className="ps-button ps-button--secondary" disabled={session.busy}
      onClick={() => void oneFlight(sendPrepared)}>{t("encryptedItems.retrySame")}</button>}
    {session.deleting && <section className="ps-card" aria-label={labels.delete}>
      <h3>{session.deleting.display.title}</h3><p>{labels.confirmDelete}</p>
      <div className="ps-actions"><button type="button" className="ps-button ps-button--secondary"
        disabled={session.busy || session.outcome !== "none"} onClick={confirmRemove}>{labels.delete}</button>
        <button type="button" className="ps-button ps-button--secondary" disabled={session.busy} onClick={cancel}>{labels.cancelEdit}</button></div>
    </section>}
    {session.draft ? <div className="encrypted-items__form" ref={formHost}>
      <ItemForm mode={session.draft.original ? "edit" : "create"} values={session.draft.values}
        labels={{ ...labels, submitAdd: labels.submitSave }} disabled={session.busy || !!session.prepared || session.outcome !== "none"}
        onChange={(values) => { if (active() && !session.busy && !session.prepared && session.draft) {
          if (values.category !== session.draft.values.category) {
            session.revealed = false;
            const input = formHost.current?.querySelector<HTMLInputElement>('input[autocomplete="new-password"]');
            if (input) input.type = "password";
          }
          session.draft.values = values; changed();
        } }}
        onSubmit={save} onCancel={cancel} />
      {(session.draft.values.category === "LOGIN" || session.draft.values.category === "PASSWORD") &&
        <button type="button" className="ps-button ps-button--secondary encrypted-items__eye" disabled={session.busy}
          aria-pressed={session.revealed} aria-label={t(session.revealed ? "encryptedItems.hidePassword" : "encryptedItems.showPassword")}
          onClick={() => {
            const input = formHost.current?.querySelector<HTMLInputElement>('input[autocomplete="new-password"]');
            if (input && active()) { session.revealed = !session.revealed; input.type = session.revealed ? "text" : "password"; changed(); }
          }}>{t(session.revealed ? "encryptedItems.hidePassword" : "encryptedItems.showPassword")}</button>}
      <div className="encrypted-items__footer">
        <button type="button" className="ps-button ps-button--primary" disabled={session.busy || !!session.prepared || session.outcome !== "none"}
          onClick={() => { if (active()) formHost.current?.querySelector("form")?.requestSubmit(); }}>{labels.submitSave}</button>
        <button type="button" className="ps-button ps-button--secondary" disabled={session.busy} onClick={cancel}>{labels.cancelEdit}</button>
      </div>
    </div> : session.ready && <div className="encrypted-items__list">
      <div className="encrypted-items__row encrypted-items__head" aria-hidden="true">
        <span>{labels.fieldTitle}</span><span>{labels.fieldUsername}</span><span>{labels.fieldPassword}</span><span>{t("encryptedItems.actions")}</span>
      </div>
      <ul>{rows.map((row) => <li className="encrypted-items__row" key={row.context.itemId}>
        <div><strong>{row.display.title}</strong>{row.display.url && <span className="encrypted-items__url">{row.display.url}</span>}</div>
        <span><span className="encrypted-items__mobile-label">{labels.fieldUsername}: </span>{row.display.username || labels.notSet}</span>
        <span><span className="encrypted-items__mobile-label">{labels.fieldPassword}: </span>{row.display.password ? "••••••••" : labels.notSet}</span>
        <div className="encrypted-items__actions"><button type="button" className="ps-button ps-button--secondary" disabled={blocked}
          onClick={() => startDraft(row)} aria-label={`${labels.edit}: ${row.display.title}`}>{labels.edit}</button>
          <button type="button" className="ps-button ps-button--secondary" disabled={blocked}
            onClick={() => remove(row)} aria-label={`${labels.delete}: ${row.display.title}`}>{labels.delete}</button></div>
      </li>)}</ul>
      {rows.length === 0 && <p>{labels.emptyList}</p>}
    </div>}
    {session.error && <p className="ps-error" role="alert">{t(session.error)}</p>}
    <p className="cloud-note">{t("encryptedItems.deviceOnly")}</p>
  </div>;
}
