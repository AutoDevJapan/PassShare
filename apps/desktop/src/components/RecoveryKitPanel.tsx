import { useState } from "react";
import { copyTextWithAutoClear } from "@shared/ui/clipboard-auto-clear";
import { useDesktopLabels } from "../hooks/useDesktopLabels";

type RecoveryKitPanelProps = {
  secret: string;
  onConfirm: () => void;
};

export function RecoveryKitPanel({ secret, onConfirm }: RecoveryKitPanelProps) {
  const labels = useDesktopLabels();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await copyTextWithAutoClear(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
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
      <pre className="ps-code-block ps-recovery-secret">
        <code>{secret}</code>
      </pre>
      <div className="ps-actions">
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleCopy()}>
          {copied ? labels.recovery.copied : labels.recovery.copy}
        </button>
        <button type="button" className="ps-button ps-button--primary" onClick={onConfirm}>
          {labels.recovery.confirm}
        </button>
      </div>
    </section>
  );
}
