import { useEffect, useRef, useState } from "react";
import { copyTextWithAutoClear } from "@shared/ui/clipboard-auto-clear";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
import { useLocalRecoverySession } from "../hooks/useLocalRecoverySession";

type RecoveryKitPanelProps = {
  secret: string;
  onConfirm: () => void;
  onDismiss: () => void;
};

export function RecoveryKitPanel({ secret, onConfirm, onDismiss }: RecoveryKitPanelProps) {
  const labels = useDesktopLabels();
  const [copied, setCopied] = useState(false);
  const [stored, setStored] = useState(false);
  const [failed, setFailed] = useState(false);
  const output = useRef<HTMLElement>(null);
  const copying = useRef(false);
  const native = useLocalRecoverySession(() => { if (output.current) output.current.textContent = ""; }, onDismiss);
  useEffect(() => {
    if (output.current && native.ready) output.current.textContent = secret;
    return () => { if (output.current) output.current.textContent = ""; };
  }, [secret, native.ready]);

  async function handleCopy() {
    if (copying.current || !native.ready || !output.current?.textContent) return;
    copying.current = true;
    const current = native.generation.current;
    try {
      await copyTextWithAutoClear(output.current.textContent);
      if (current === native.generation.current) setCopied(true);
    } catch {
      if (current === native.generation.current) setFailed(true);
    } finally { copying.current = false; }
  }

  return (
    <section className="ps-card ps-card--accent" aria-labelledby="recovery-kit-heading">
      <div className="ps-card__header">
        <span className="ps-badge">{labels.recovery.badge}</span>
        <h2 className="ps-heading-3" id="recovery-kit-heading">
          {labels.recovery.title}
        </h2>
      </div>
      <p className="ps-text-muted">{labels.recovery.lead}</p>
      <pre className="ps-code-block ps-recovery-secret" style={{ whiteSpace: "pre-wrap" }}>
        <code ref={output} />
      </pre>
      <label className="ps-label ps-label--checkbox"><input type="checkbox" checked={stored} onChange={(event) => setStored(event.target.checked)} />{labels.localRecovery.stored}</label>
      {failed ? <p role="alert">{labels.localRecovery.copyFailed}</p> : null}
      <div className="ps-actions">
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleCopy()}>
          {copied ? labels.recovery.copied : labels.recovery.copy}
        </button>
        <button type="button" className="ps-button ps-button--primary" disabled={!stored || !native.ready} onClick={() => { if (output.current) output.current.textContent = ""; onConfirm(); }}>
          {labels.recovery.confirm}
        </button>
      </div>
    </section>
  );
}
