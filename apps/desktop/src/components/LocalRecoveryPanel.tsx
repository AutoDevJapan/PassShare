import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyTextWithAutoClear } from "@shared/ui/clipboard-auto-clear";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
import { useLocalRecoverySession } from "../hooks/useLocalRecoverySession";
import { StatusMessage } from "./StatusMessage";

type RecoveryInfo = { name: string; path: string; epoch: number };
type BoxDirectory = { directory: string; parent: string | null; entries: { name: string; path: string; directory: boolean }[] };
type Props = {
  mode: "recover" | "enable";
  initialPath?: string;
  onClose: () => void;
  onRecovered?: (path: string, password: string) => void;
};

export function LocalRecoveryPanel({ mode, initialPath = "", onClose, onRecovered }: Props) {
  const { localRecovery: labels, setup, recovery } = useDesktopLabels();
  const path = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const output = useRef<HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [info, setInfo] = useState<RecoveryInfo | null>(null);
  const [shown, setShown] = useState(false);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const [directory, setDirectory] = useState<BoxDirectory | null>(null);
  function erase() {
    for (const input of [code.current, password.current, confirmation.current, output.current]) {
      if (input) input.value = "";
    }
  }
  const native = useLocalRecoverySession(erase, onClose, mode === "recover");

  useEffect(() => {
    if (!native.ready || mode !== "enable") return;
    const current = native.generation.current;
    void invoke<RecoveryInfo>("local_recovery_info").then((value) => {
      if (current === native.generation.current && value.epoch === native.session.current?.epoch) setInfo(value);
    }).catch(() => { if (current === native.generation.current) setMessage(labels.failed); });
  }, [native.ready, mode, labels.failed]);

  async function browse(folder?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const current = native.generation.current;
    try {
      const value = await invoke<BoxDirectory>("browse_password_box_directory", { directory: folder ?? null });
      if (current === native.generation.current) setDirectory(value);
    } catch {
      if (current === native.generation.current) setMessage(labels.browseFailed);
    } finally {
      if (current === native.generation.current) { busyRef.current = false; setBusy(false); }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !native.ready || !native.session.current) return;
    const selectedPath = path.current?.value.trim() ?? info?.path ?? "";
    let newPassword = password.current?.value ?? "";
    let recoveryCode = code.current?.value ?? "";
    let repeat = confirmation.current?.value ?? "";
    if (!selectedPath || !newPassword || (mode === "recover" && !recoveryCode)) {
      setMessage(labels.required); return;
    }
    if (mode === "recover" && newPassword !== repeat) { setMessage(labels.mismatch); return; }
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    const current = native.generation.current;
    const { epoch, ticket } = native.session.current;
    erase();
    try {
      let result = "";
      if (mode === "recover") {
        await invoke("recover_password_box", { path: selectedPath, code: recoveryCode, newPassword, confirmation: repeat, epoch, ticket });
      } else {
        result = await invoke<string>("enable_password_box_recovery", { currentPassword: newPassword, epoch, ticket });
      }
      recoveryCode = ""; repeat = "";
      const status = await invoke<{ epoch: number; unlocked: boolean }>("native_session_status");
      if (current !== native.generation.current || document.hidden || !status.unlocked
        || status.epoch !== epoch + (mode === "recover" ? 1 : 0)) { result = ""; return; }
      if (mode === "recover") {
        native.complete();
        onRecovered?.(selectedPath, newPassword);
        newPassword = "";
      } else {
        if (output.current) output.current.value = result;
        result = "";
        setShown(true);
      }
    } catch {
      if (current === native.generation.current) setMessage(labels.failed);
    } finally {
      newPassword = ""; recoveryCode = ""; repeat = "";
      if (current === native.generation.current) { busyRef.current = false; setBusy(false); }
    }
  }

  async function copy() {
    if (busyRef.current || !output.current?.value) return;
    busyRef.current = true;
    const current = native.generation.current;
    try {
      await copyTextWithAutoClear(output.current.value);
      if (current === native.generation.current) setCopied(true);
    } catch {
      if (current === native.generation.current) setMessage(labels.copyFailed);
    } finally { if (current === native.generation.current) busyRef.current = false; }
  }

  return (
    <section className="ps-card ps-card--accent" aria-labelledby="local-recovery-heading">
      <h2 className="ps-heading-3" id="local-recovery-heading">{mode === "recover" ? labels.title : labels.enableTitle}</h2>
      <form onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Enter" && event.repeat) event.preventDefault(); }}>
        {mode === "recover" ? (
          <label className="ps-label">{setup.pathLabel}
            <div className="ps-actions">
              <input ref={path} className="ps-input" style={{ flex: "1 1 12rem", minWidth: 0 }} defaultValue={initialPath} disabled={busy || !native.ready} required />
              <button type="button" className="ps-button ps-button--secondary" disabled={busy || !native.ready} onClick={() => void browse()}>{labels.browse}</button>
            </div>
          </label>
        ) : <>
          <label className="ps-label">{labels.boxName}<input className="ps-input" value={info?.name ?? ""} readOnly /></label>
          <label className="ps-label">{setup.pathLabel}<input className="ps-input" value={info?.path ?? ""} readOnly /></label>
        </>}
        {directory ? <div className="ps-card">
          <p className="ps-text-muted" style={{ overflowWrap: "anywhere" }}>{directory.directory}</p>
          {directory.parent ? <button type="button" className="ps-button ps-button--secondary" disabled={busy} onClick={() => void browse(directory.parent!)}>{labels.parentFolder}</button> : null}
          <ul style={{ paddingLeft: "1rem", maxHeight: "16rem", overflow: "auto" }}>
            {directory.entries.map((entry) => <li key={entry.path}><button type="button" className="ps-button ps-button--secondary" style={{ maxWidth: "100%", overflowWrap: "anywhere", textAlign: "start" }} disabled={busy} onClick={() => {
              if (entry.directory) void browse(entry.path);
              else { if (path.current) path.current.value = entry.path; setDirectory(null); }
            }}>{entry.directory ? `${entry.name}/` : entry.name}</button></li>)}
          </ul>
          <button type="button" className="ps-button ps-button--secondary" onClick={() => setDirectory(null)}>{labels.closeBrowse}</button>
        </div> : null}
        {!shown ? <>
          {mode === "recover" ? <label className="ps-label">{labels.code}<input ref={code} className="ps-input" type="password" autoComplete="off" disabled={busy || !native.ready} required /></label> : null}
          <label className="ps-label">{mode === "recover" ? labels.newPassword : labels.currentPassword}<input ref={password} className="ps-input" type="password" autoComplete={mode === "recover" ? "new-password" : "current-password"} disabled={busy || !native.ready || (mode === "enable" && !info)} required /></label>
          {mode === "recover" ? <label className="ps-label">{labels.repeat}<input ref={confirmation} className="ps-input" type="password" autoComplete="new-password" disabled={busy || !native.ready} required /></label> : null}
          <p className="ps-text-muted">{mode === "recover" ? labels.saveExplanation : labels.enableExplanation}</p>
          <button type="submit" className="ps-button ps-button--primary" disabled={busy || !native.ready || (mode === "enable" && !info)}>{busy ? labels.working : mode === "recover" ? labels.save : labels.enable}</button>
        </> : null}
      </form>
      <div hidden={!shown}>
        <p>{labels.code}</p>
        <textarea ref={output} className="ps-input ps-recovery-secret" readOnly rows={3} autoComplete="off" aria-label={labels.code} style={{ resize: "none", overflowWrap: "anywhere" }} />
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void copy()}>{copied ? recovery.copied : recovery.copy}</button>
        <label className="ps-label ps-label--checkbox"><input type="checkbox" checked={stored} onChange={(event) => setStored(event.target.checked)} />{labels.stored}</label>
      </div>
      <div className="ps-actions" style={{ marginTop: "1rem" }}>
        <button type="button" className="ps-button ps-button--secondary" disabled={shown && !stored} onClick={() => { erase(); onClose(); }}>{mode === "recover" ? labels.back : labels.close}</button>
      </div>
      <p className="ps-text-muted">{mode === "recover" ? labels.enabledRequired : labels.newVersion}</p>
      <p className="ps-text-muted">{mode === "recover" ? labels.failureExplanation : labels.backups}</p>
      {mode === "enable" ? <p className="ps-text-muted">{labels.enableRetry}</p> : null}
      <p className="ps-text-muted">{labels.localOnly}</p>
      {message || native.failed ? <StatusMessage message={message || labels.failed} variant="error" /> : null}
    </section>
  );
}
