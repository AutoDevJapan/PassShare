import { useEffect, useState } from "react";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
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
  const labels = useDesktopLabels();
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
      setMessage(labels.biometric.errorLocked);
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      await enableBiometricUnlock(boxPath, masterPassword);
      setEnabled(true);
      setMessage(labels.biometric.successEnabled);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : labels.biometric.errorEnable);
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
      setMessage(labels.biometric.successDisabled);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : labels.biometric.errorDisable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ps-card ps-card--compact" aria-labelledby="biometric-unlock-heading">
      <h3 className="ps-heading-3" id="biometric-unlock-heading">
        {labels.biometric.title}
      </h3>
      <p className="ps-text-muted">{labels.biometric.lead}</p>
      <div className="ps-actions">
        {enabled ? (
          <button type="button" className="ps-button ps-button--secondary" disabled={busy} onClick={() => void handleDisable()}>
            {labels.biometric.disable}
          </button>
        ) : (
          <button type="button" className="ps-button ps-button--secondary" disabled={busy} onClick={() => void handleEnable()}>
            {labels.biometric.enable}
          </button>
        )}
      </div>
      {message ? <p className="ps-text-muted">{message}</p> : null}
    </section>
  );
}
