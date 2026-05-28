import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@shared/i18n/I18nProvider";
import { applyDocumentLocale, resolveInitialLocale } from "@shared/i18n/index";
import { AuthSessionProvider } from "./hooks/useAuthSession";
import { App } from "./App";
import "./style.css";

applyDocumentLocale(resolveInitialLocale());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <AuthSessionProvider>
        <App />
      </AuthSessionProvider>
    </I18nProvider>
  </StrictMode>,
);
