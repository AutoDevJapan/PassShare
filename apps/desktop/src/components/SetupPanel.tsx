import { useEffect, useState } from "react";
import { createPasswordBox, openPasswordBox } from "../tauri";
import { formatTauriError } from "../errors";
import { hasBiometricUnlock, isBiometricAvailable, unlockWithBiometric } from "../biometric-unlock";
import { RecoveryKitPanel } from "./RecoveryKitPanel";
import { StatusMessage } from "./StatusMessage";

type SetupPanelProps = {
  boxPath: string;
  masterPassword: string;
  onBoxPathChange: (value: string) => void;
  onMasterPasswordChange: (value: string) => void;
  onUnlocked: () => void;
};

export function SetupPanel({
  boxPath,
  masterPassword,
  onBoxPathChange,
  onMasterPasswordChange,
  onUnlocked,
}: SetupPanelProps) {
  const [message, setMessage] = useState("");
  const [messageVariant, setMessageVariant] = useState<"info" | "error" | "success">("info");
  const [busy, setBusy] = useState(false);
  const [recoverySecret, setRecoverySecret] = useState<string | null>(null);
  const [biometricReady, setBiometricReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadBiometricState() {
      if (!boxPath.trim()) {
        if (!cancelled) {
          setBiometricReady(false);
        }
        return;
      }

      const [available, enabled] = await Promise.all([
        isBiometricAvailable(),
        hasBiometricUnlock(boxPath),
      ]);

      if (!cancelled) {
        setBiometricReady(available && enabled);
      }
    }

    void loadBiometricState();

    return () => {
      cancelled = true;
    };
  }, [boxPath]);

  function showMessage(text: string, variant: "info" | "error" | "success" = "info") {
    setMessage(text);
    setMessageVariant(variant);
  }

  function clearMessage() {
    setMessage("");
  }

  async function handleCreate() {
    if (!boxPath.trim()) {
      showMessage("ファイルの場所を入力してください。", "error");
      return;
    }
    if (!masterPassword) {
      showMessage("マスターパスワードを入力してください。", "error");
      return;
    }

    setBusy(true);
    clearMessage();
    try {
      const recovery = await createPasswordBox(boxPath.trim(), masterPassword);
      if (recovery) {
        setRecoverySecret(recovery);
        return;
      }
      showMessage("パスワードボックスを作成しました。", "success");
      onUnlocked();
    } catch (err) {
      showMessage(formatTauriError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleBiometricOpen() {
    if (!boxPath.trim()) {
      showMessage("ファイルの場所を入力してください。", "error");
      return;
    }

    setBusy(true);
    clearMessage();
    try {
      const password = await unlockWithBiometric(boxPath.trim());
      onMasterPasswordChange(password);
      await openPasswordBox(boxPath.trim(), password);
      showMessage("生体認証でパスワードボックスを開きました。", "success");
      onUnlocked();
    } catch (err) {
      showMessage(formatTauriError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    if (!boxPath.trim()) {
      showMessage("ファイルの場所を入力してください。", "error");
      return;
    }
    if (!masterPassword) {
      showMessage("マスターパスワードを入力してください。", "error");
      return;
    }

    setBusy(true);
    clearMessage();
    try {
      await openPasswordBox(boxPath.trim(), masterPassword);
      showMessage("パスワードボックスを開きました。", "success");
      onUnlocked();
    } catch (err) {
      showMessage(formatTauriError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  if (recoverySecret) {
    return (
      <RecoveryKitPanel
        secret={recoverySecret}
        onConfirm={() => {
          setRecoverySecret(null);
          onUnlocked();
        }}
      />
    );
  }

  return (
    <section className="ps-card" aria-labelledby="setup-heading">
      <h2 className="ps-heading-3" id="setup-heading">
        パスワードボックスを開く
      </h2>
      <p className="ps-text-muted">
        初めての方は、保存先のファイルパスを決めて「新規作成」を押してください。
      </p>

      <label className="ps-label">
        ファイルの場所
        <input
          className="ps-input"
          type="text"
          value={boxPath}
          onChange={(event) => onBoxPathChange(event.target.value)}
          placeholder="例: C:\Users\あなた\Documents\mypasswords.pbox"
          disabled={busy}
        />
      </label>

      <label className="ps-label">
        マスターパスワード
        <input
          className="ps-input"
          type="password"
          autoComplete="new-password"
          value={masterPassword}
          onChange={(event) => onMasterPasswordChange(event.target.value)}
          disabled={busy}
        />
      </label>

      <div className="ps-actions">
        {biometricReady ? (
          <button
            type="button"
            className="ps-button ps-button--primary"
            onClick={() => void handleBiometricOpen()}
            disabled={busy}
          >
            生体認証で開く
          </button>
        ) : null}
        <button
          type="button"
          className="ps-button ps-button--primary"
          onClick={() => void handleCreate()}
          disabled={busy}
        >
          新規作成
        </button>
        <button
          type="button"
          className="ps-button ps-button--secondary"
          onClick={() => void handleOpen()}
          disabled={busy}
        >
          開く
        </button>
      </div>

      {message ? <StatusMessage message={message} variant={messageVariant} /> : null}
    </section>
  );
}
