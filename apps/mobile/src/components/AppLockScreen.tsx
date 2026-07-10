import { useEffect, useState, type FormEvent } from "react";
import { getPinLockState, hasAppPin, setAppPin, verifyAppPin } from "../lib/app-lock";
import { authenticateBiometric, isBiometricAvailable } from "../lib/secure-storage";
import { useMobileLabels } from "../hooks/useMobileLabels";

type Props = {
  onUnlocked: () => void;
};

export function AppLockScreen({ onUnlocked }: Props) {
  const labels = useMobileLabels();
  const [pin, setPin] = useState("");
  const [setupPin, setSetupPinValue] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [biometricReady, setBiometricReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [pinExists, biometric] = await Promise.all([hasAppPin(), isBiometricAvailable()]);
      setNeedsSetup(!pinExists);
      setBiometricReady(biometric);
      const lockState = getPinLockState();
      setLocked(lockState.locked);
      if (lockState.locked) {
        setError(labels.lockLocked);
      }
    })();
  }, [labels.lockLocked]);

  async function unlockWithBiometric() {
    setError(null);
    try {
      await authenticateBiometric(labels.lockBiometric);
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.lockLead);
    }
  }

  async function handlePinUnlock(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const result = await verifyAppPin(pin);
    if (result.status === "ok") {
      setLocked(false);
      onUnlocked();
      return;
    }
    if (result.status === "locked") {
      setLocked(true);
      setError(labels.lockLocked);
      return;
    }
    setError(labels.lockPinMismatch);
  }

  async function handlePinSetup(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (setupPin !== setupConfirm) {
      setError(labels.lockPinMismatch);
      return;
    }
    try {
      await setAppPin(setupPin);
    } catch {
      setError(labels.lockPinTooShort);
      return;
    }
    setNeedsSetup(false);
    onUnlocked();
  }

  if (needsSetup === null) {
    return <div className="mobile-loading">{labels.lockTitle}</div>;
  }

  return (
    <section className="mobile-panel mobile-panel--lock">
      <header className="mobile-panel__header">
        <h1 className="ps-heading-2">{labels.lockTitle}</h1>
        <p className="mobile-panel__lead">{labels.lockLead}</p>
      </header>

      {needsSetup ? (
        <form className="mobile-form ps-card" onSubmit={(event) => void handlePinSetup(event)}>
          <label className="ps-label ps-label--full">
            {labels.lockSetupPin}
            <input
              className="ps-input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={setupPin}
              onChange={(event) => setSetupPinValue(event.target.value)}
              placeholder={labels.lockPinPlaceholder}
              required
            />
          </label>
          <label className="ps-label ps-label--full">
            {labels.lockSetupPinConfirm}
            <input
              className="ps-input"
              inputMode="numeric"
              pattern="[0-9]*"
              value={setupConfirm}
              onChange={(event) => setSetupConfirm(event.target.value)}
              placeholder={labels.lockPinPlaceholder}
              required
            />
          </label>
          <button type="submit" className="ps-button ps-button--full">
            {labels.lockUnlock}
          </button>
        </form>
      ) : (
        <>
          {biometricReady ? (
            <button type="button" className="ps-button ps-button--full" onClick={() => void unlockWithBiometric()}>
              {labels.lockBiometric}
            </button>
          ) : null}
          <form className="mobile-form ps-card" onSubmit={(event) => void handlePinUnlock(event)}>
            <label className="ps-label ps-label--full">
              {labels.lockPin}
              <input
                className="ps-input"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder={labels.lockPinPlaceholder}
                disabled={locked}
                required
              />
            </label>
            <button type="submit" className="ps-button ps-button--full" disabled={locked}>
              {labels.lockUnlock}
            </button>
          </form>
        </>
      )}

      {error ? (
        <p className="ps-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
