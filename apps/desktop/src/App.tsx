import { useEffect, useRef, useState } from "react";
import { MatrixBackground } from "../../../shared/ui/MatrixBackground";
import type { AppView } from "./types";
import { getState } from "./tauri";
import { bindNativeLock } from "../../../shared/lib/native-lock";
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

  useEffect(() => {
    let cancelled = false;

    async function syncState() {
      const current = generation.current;
      try {
        const state = await getState();
        if (!cancelled && current === generation.current && state === "unlocked") {
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

  useEffect(() => bindNativeLock(isTauri() ? { invoke, listen } : null, handleLocked), []);

  async function handleUnlocked() {
    const current = generation.current;
    if (await getState() === "unlocked" && current === generation.current) setView("main");
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
          <MainPanel boxPath={boxPath} masterPassword={masterPassword} onLocked={handleLocked} />
        )}
      </main>
    </div>
  );
}
