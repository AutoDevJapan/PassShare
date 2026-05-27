import { useEffect, useState } from "react";
import type { AppView } from "./types";
import { getState } from "./tauri";
import { AppHeader } from "./components/AppHeader";
import { MainPanel } from "./components/MainPanel";
import { SetupPanel } from "./components/SetupPanel";

export function App() {
  const [view, setView] = useState<AppView>("setup");
  const [boxPath, setBoxPath] = useState("");
  const [masterPassword, setMasterPassword] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function syncState() {
      try {
        const state = await getState();
        if (!cancelled && state === "unlocked") {
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
    setMasterPassword("");
    setView("setup");
  }

  return (
    <main className="ps-app">
      <AppHeader />
      {view === "setup" ? (
        <SetupPanel
          boxPath={boxPath}
          masterPassword={masterPassword}
          onBoxPathChange={setBoxPath}
          onMasterPasswordChange={setMasterPassword}
          onUnlocked={() => setView("main")}
        />
      ) : (
        <MainPanel masterPassword={masterPassword} onLocked={handleLocked} />
      )}
    </main>
  );
}
