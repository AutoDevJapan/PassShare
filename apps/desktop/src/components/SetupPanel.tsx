import { useEffect, useRef, useState } from "react";
import { useDesktopLabels } from "../hooks/useDesktopLabels";
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
  const labels = useDesktopLabels();
  const [message, setMessage] = useState("");
  const [messageVariant, setMessageVariant] = useState<"info" | "error" | "success">("info");
  const [busy, setBusy] = useState(false);
  const [recoverySecret, setRecoverySecret] = useState<string | null>(null);
  const [biometricReady, setBiometricReady] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
      showMessage(labels.setup.errorPathRequired, "error");
      return;
    }
    if (!masterPassword) {
      showMessage(labels.setup.errorPasswordRequired, "error");
      return;
    }

    setBusy(true);
    clearMessage();
    try {
      const recovery = await createPasswordBox(boxPath.trim(), masterPassword);
      if (!mounted.current) return;
      if (recovery) {
        setRecoverySecret(recovery);
        return;
      }
      showMessage(labels.setup.successCreated, "success");
      onUnlocked();
    } catch (err) {
      showMessage(formatTauriError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleBiometricOpen() {
    if (!boxPath.trim()) {
      showMessage(labels.setup.errorPathRequired, "error");
      return;
    }

    setBusy(true);
    clearMessage();
    try {
      const password = await unlockWithBiometric(boxPath.trim());
      if (!mounted.current) return;
      onMasterPasswordChange(password);
      await openPasswordBox(boxPath.trim(), password);
      if (!mounted.current) return;
      showMessage(labels.setup.successBiometricOpened, "success");
      onUnlocked();
    } catch (err) {
      showMessage(formatTauriError(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    if (!boxPath.trim()) {
      showMessage(labels.setup.errorPathRequired, "error");
      return;
    }
    if (!masterPassword) {
      showMessage(labels.setup.errorPasswordRequired, "error");
      return;
    }

    setBusy(true);
    clearMessage();
    try {
      await openPasswordBox(boxPath.trim(), masterPassword);
      if (!mounted.current) return;
      showMessage(labels.setup.successOpened, "success");
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
        {labels.setup.title}
      </h2>
      <p className="ps-text-muted">{labels.setup.lead}</p>

      <label className="ps-label">
        {labels.setup.pathLabel}
        <input
          className="ps-input"
          type="text"
          value={boxPath}
          onChange={(event) => onBoxPathChange(event.target.value)}
          placeholder={labels.setup.pathPlaceholder}
          disabled={busy}
        />
      </label>

      <label className="ps-label">
        {labels.setup.masterPassword}
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
            {labels.setup.biometricOpen}
          </button>
        ) : null}
        <button
          type="button"
          className="ps-button ps-button--primary"
          onClick={() => void handleCreate()}
          disabled={busy}
        >
          {labels.setup.create}
        </button>
        <button
          type="button"
          className="ps-button ps-button--secondary"
          onClick={() => void handleOpen()}
          disabled={busy}
        >
          {labels.setup.open}
        </button>
      </div>

      {message ? <StatusMessage message={message} variant={messageVariant} /> : null}
    </section>
  );
}
