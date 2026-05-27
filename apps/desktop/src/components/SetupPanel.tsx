import { useState } from "react";
import { createPasswordBox, openPasswordBox } from "../tauri";

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
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  function showMessage(text: string, error = false) {
    setMessage(text);
    setIsError(error);
  }

  async function handleCreate() {
    setBusy(true);
    try {
      const recovery = await createPasswordBox(boxPath.trim(), masterPassword);
      showMessage(
        recovery
          ? `パスワードボックスを作成しました。緊急キット: ${recovery}（必ず控えてください）`
          : "パスワードボックスを作成しました。",
      );
      onUnlocked();
    } catch (err) {
      showMessage(String(err), true);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    setBusy(true);
    try {
      await openPasswordBox(boxPath.trim(), masterPassword);
      showMessage("パスワードボックスを開きました。");
      onUnlocked();
    } catch (err) {
      showMessage(String(err), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ps-panel ps-panel-spaced" aria-labelledby="setup-heading">
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
        />
      </label>

      <div className="ps-actions">
        <button
          type="button"
          className="ps-button ps-button--primary"
          onClick={handleCreate}
          disabled={busy}
        >
          新規作成
        </button>
        <button
          type="button"
          className="ps-button ps-button--secondary"
          onClick={handleOpen}
          disabled={busy}
        >
          開く
        </button>
      </div>

      {message ? (
        <p className={`ps-message${isError ? " ps-message--error" : ""}`} role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
