import { useState } from "react";

type RecoveryKitPanelProps = {
  secret: string;
  onConfirm: () => void;
};

export function RecoveryKitPanel({ secret, onConfirm }: RecoveryKitPanelProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="ps-card ps-card--accent" aria-labelledby="recovery-kit-heading">
      <div className="ps-card__header">
        <span className="ps-badge">重要</span>
        <h2 className="ps-heading-3" id="recovery-kit-heading">
          緊急キット
        </h2>
      </div>
      <p className="ps-text-muted">
        パスワードボックスを作成しました。以下のリカバリ用シークレットキーを必ず安全な場所に控えてください。
        マスターパスワードを忘れた場合の復旧に使います。
      </p>
      <pre className="ps-code-block ps-recovery-secret">
        <code>{secret}</code>
      </pre>
      <div className="ps-actions">
        <button type="button" className="ps-button ps-button--secondary" onClick={() => void handleCopy()}>
          {copied ? "コピーしました" : "緊急キットをコピー"}
        </button>
        <button type="button" className="ps-button ps-button--primary" onClick={onConfirm}>
          控えました — 続ける
        </button>
      </div>
    </section>
  );
}
