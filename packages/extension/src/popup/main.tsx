import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyDocumentLocale, resolveInitialLocale } from "@shared/i18n/index";
import { I18nProvider } from "@shared/i18n/I18nProvider";
import { App } from "./App";
import { AuthSessionProvider } from "./hooks/useAuthSession";
import "./style.css";
import "@shared/styles/index.css";

applyDocumentLocale(resolveInitialLocale());

const root = document.getElementById("root");
if (!root) {
  throw new Error("Popup root element not found");
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <AuthSessionProvider>
        <App />
      </AuthSessionProvider>
    </I18nProvider>
  </StrictMode>,
);
