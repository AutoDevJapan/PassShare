import { useState } from "react";
import { MatrixBackground } from "@shared/ui/MatrixBackground";
import { LoginPanel } from "./components/LoginPanel";
import { ItemsPanel } from "./components/ItemsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { useAuthSession } from "./hooks/useAuthSession";
import { useExtensionLabels } from "./hooks/useExtensionLabels";

type Tab = "items" | "settings";

export function App() {
  const labels = useExtensionLabels();
  const { user, loading } = useAuthSession();
  const [tab, setTab] = useState<Tab>("items");

  if (loading) {
    return <div className="ext-loading">{labels.appTitle}</div>;
  }

  if (!user) {
    return (
      <div className="ext-shell">
        <MatrixBackground className="matrix-rain--fixed" />
        <main className="ext-app">
          <LoginPanel />
        </main>
      </div>
    );
  }

  return (
    <div className="ext-shell">
      <MatrixBackground className="matrix-rain--fixed" />
      <main className="ext-app ext-app--with-nav">
        {tab === "items" ? <ItemsPanel /> : <SettingsPanel />}
        <nav className="ext-nav" aria-label="Extension navigation">
          <button
            type="button"
            className={tab === "items" ? "ext-nav__btn ext-nav__btn--active" : "ext-nav__btn"}
            onClick={() => setTab("items")}
          >
            {labels.navItems}
          </button>
          <button
            type="button"
            className={tab === "settings" ? "ext-nav__btn ext-nav__btn--active" : "ext-nav__btn"}
            onClick={() => setTab("settings")}
          >
            {labels.navSettings}
          </button>
        </nav>
      </main>
    </div>
  );
}
