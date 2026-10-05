import { useEffect, useRef, useState } from "react";
import { MatrixBackground } from "../../../shared/ui/MatrixBackground";
import type { AppView } from "./types";
import { bindNativeLock, type NativeStatus } from "../../../shared/lib/native-lock";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppHeader } from "./components/AppHeader";
import { MainPanel } from "./components/MainPanel";
import { SetupPanel } from "./components/SetupPanel";

export function App() {
  const [view, setView] = useState<AppView>("setup");
  const [boxPath, setBoxPath] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [lockGeneration, setLockGeneration] = useState(0);
  const generation = useRef(0);
  const nativeBinding = useRef<ReturnType<typeof bindNativeLock> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function syncState() {
      const current = generation.current;
      try {
        const status = await invoke<NativeStatus>("native_session_status");
        nativeBinding.current?.accept(status);
        if (!cancelled && current === generation.current && status.unlocked) {
          setView("main");
        }
      } catch {
        // Tauri unavailable outside desktop shell — stay on setup view.
      }
    }

    void syncState();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleLocked() {
    generation.current += 1;
    setLockGeneration(generation.current);
    setMasterPassword("");
    setView("setup");
  }

  useEffect(() => {
    const binding = bindNativeLock(isTauri() ? { invoke, listen } : null, handleLocked);
    nativeBinding.current = binding;
    return () => { binding.dispose(); nativeBinding.current = null; };
  }, []);

  async function handleUnlocked() {
    const current = generation.current;
    const status = await invoke<NativeStatus>("native_session_status");
    nativeBinding.current?.accept(status);
    if (status.unlocked && current === generation.current) setView("main");
  }

  async function handleManualLocked() {
    nativeBinding.current?.accept(await invoke<NativeStatus>("native_session_status"));
  }

  return (
    <div className="ps-app-shell">
      <MatrixBackground className="matrix-rain--fixed" />
      <main className="ps-app">
        <AppHeader />
        {view === "setup" ? (
          <SetupPanel
            key={lockGeneration}
            boxPath={boxPath}
            masterPassword={masterPassword}
            onBoxPathChange={setBoxPath}
            onMasterPasswordChange={setMasterPassword}
            onUnlocked={() => void handleUnlocked()}
          />
        ) : (
          <MainPanel boxPath={boxPath} masterPassword={masterPassword} onLocked={() => void handleManualLocked()} />
        )}
      </main>
    </div>
  );
}
