import { useEffect, useState } from "react";
import {
  disableBiometricUnlock,
  enableBiometricUnlock,
  hasBiometricUnlock,
  isBiometricAvailable,
} from "../biometric-unlock";

type BiometricUnlockSettingsProps = {
  boxPath: string;
  masterPassword: string;
};

export function BiometricUnlockSettings({ boxPath, masterPassword }: BiometricUnlockSettingsProps) {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [isAvailable, isEnabled] = await Promise.all([
        isBiometricAvailable(),
        hasBiometricUnlock(boxPath),
      ]);
      if (!cancelled) {
        setAvailable(isAvailable);
        setEnabled(isEnabled);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [boxPath]);

  if (!available) {
    return null;
  }

  async function handleEnable() {
    if (!boxPath.trim() || !masterPassword) {
      setMessage("パスワードボックスを開いた状態でのみ有効化できます。");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      await enableBiometricUnlock(boxPath, masterPassword);
      setEnabled(true);
      setMessage("生体認証で開くを有効にしました。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "生体認証の有効化に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setMessage("");
    try {
      await disableBiometricUnlock(boxPath);
      setEnabled(false);
      setMessage("生体認証で開くを無効にしました。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "生体認証の無効化に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ps-card ps-card--compact" aria-labelledby="biometric-unlock-heading">
      <h3 className="ps-heading-3" id="biometric-unlock-heading">
        生体認証で開く
      </h3>
      <p className="ps-text-muted">
        Windows Hello / Touch ID / Face ID / 指紋で、次回からマスターパスワード入力を省略できます。
      </p>
      <div className="ps-actions">
        {enabled ? (
          <button type="button" className="ps-button ps-button--secondary" disabled={busy} onClick={() => void handleDisable()}>
            無効にする
          </button>
        ) : (
          <button type="button" className="ps-button ps-button--secondary" disabled={busy} onClick={() => void handleEnable()}>
            有効にする
          </button>
        )}
      </div>
      {message ? <p className="ps-text-muted">{message}</p> : null}
    </section>
  );
}
