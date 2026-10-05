import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bindNativeLock } from "@shared/lib/native-lock";
import { MatrixBackground } from "@shared/ui/MatrixBackground";
import { useAuthSession } from "./hooks/useAuthSession";
import { AppLockScreen } from "./components/AppLockScreen";
import { BottomNav } from "./components/BottomNav";
import { ItemsPanel } from "./components/ItemsPanel";
import { LoginPanel } from "./components/LoginPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { VaultListPanel } from "./components/VaultListPanel";
import { useMobileLabels } from "./hooks/useMobileLabels";

type Tab = "vaults" | "settings";

export function App() {
  const labels = useMobileLabels();
  const { user, loading, suspend, resume } = useAuthSession();
  const [unlocked, setUnlocked] = useState(false);
  const [tab, setTab] = useState<Tab>("vaults");
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [lockGeneration, setLockGeneration] = useState(0);
  const generation = useRef(0);

  const handleLocked = useCallback(() => {
    generation.current += 1;
    setLockGeneration(generation.current);
    setUnlocked(false);
    setSelectedVaultId(null);
    suspend();
  }, [suspend]);
  useEffect(() => bindNativeLock(isTauri() ? { invoke, listen } : null, handleLocked), [handleLocked]);

  async function handleUnlocked(epoch: number) {
    const current = generation.current;
    if (isTauri() && !await invoke<boolean>("native_unlock", { epoch })) return;
    if (!await resume()) return;
    const open = !isTauri() || await invoke<boolean>("native_is_unlocked");
    if (open && current === generation.current) setUnlocked(true);
  }

  if (loading) {
    return <div className="mobile-loading">{labels.appTitle}</div>;
  }

  if (!user) {
    return (
      <div className="mobile-shell">
        <MatrixBackground className="matrix-rain--fixed" />
        <main className="mobile-app">
          <LoginPanel />
        </main>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="mobile-shell">
        <MatrixBackground className="matrix-rain--fixed" />
        <main className="mobile-app">
          <AppLockScreen key={lockGeneration} onUnlocked={(epoch) => void handleUnlocked(epoch)} />
        </main>
      </div>
    );
  }

  return (
    <div className="mobile-shell">
      <MatrixBackground className="matrix-rain--fixed" />
      <main className="mobile-app mobile-app--with-nav">
        {selectedVaultId ? (
          <ItemsPanel vaultId={selectedVaultId} onBack={() => setSelectedVaultId(null)} />
        ) : tab === "vaults" ? (
          <VaultListPanel onSelectVault={setSelectedVaultId} />
        ) : (
          <SettingsPanel />
        )}
        {!selectedVaultId ? <BottomNav active={tab} onChange={setTab} /> : null}
      </main>
    </div>
  );
}
