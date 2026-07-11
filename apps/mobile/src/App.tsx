import { useCallback, useState } from "react";
import { MatrixBackground } from "@shared/ui/MatrixBackground";
import { useAuthSession } from "./hooks/useAuthSession";
import { useAutoLock } from "./hooks/useAutoLock";
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
  const { user, loading } = useAuthSession();
  const [unlocked, setUnlocked] = useState(false);
  const [tab, setTab] = useState<Tab>("vaults");
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);

  // Re-lock on background/idle so an unlocked, unattended device cannot reach
  // the password boxes. Runs only while unlocked; re-unlock goes through the
  // biometric/PIN AppLockScreen again (#408).
  const relock = useCallback(() => {
    setUnlocked(false);
    setSelectedVaultId(null);
  }, []);
  useAutoLock(unlocked, relock);

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
          <AppLockScreen onUnlocked={() => setUnlocked(true)} />
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
