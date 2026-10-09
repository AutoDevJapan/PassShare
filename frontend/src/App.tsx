import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { ProtectedRoute } from "./app/ProtectedRoute";
import { ItemsPage } from "./pages/app/ItemsPage";
import { CloudEncryptionPage } from "./pages/app/CloudEncryptionPage";
import { VaultsPage } from "./pages/app/VaultsPage";
import { VaultSharePage } from "./pages/app/VaultSharePage";
import { InvitationsPage } from "./pages/app/InvitationsPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { ResetPasswordPage } from "./pages/auth/ResetPasswordPage";
import { SignupPage } from "./pages/auth/SignupPage";
import { LandingPage } from "./pages/LandingPage";
import { DocsIndexPage } from "./pages/docs/DocsIndexPage";
import { ExtensionInstallPage } from "./pages/docs/ExtensionInstallPage";
import { FaqPage } from "./pages/docs/FaqPage";
import { PrivacyPage } from "./pages/docs/PrivacyPage";
import { TermsPage } from "./pages/docs/TermsPage";
import { UserGuidePage } from "./pages/docs/UserGuidePage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/docs" element={<DocsIndexPage />} />
        <Route path="/docs/user-guide" element={<UserGuidePage />} />
        <Route path="/docs/extension" element={<ExtensionInstallPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/faq" element={<FaqPage />} />
        <Route path="/app/login" element={<LoginPage />} />
        <Route path="/app/signup" element={<SignupPage />} />
        <Route path="/app/reset-password" element={<ResetPasswordPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<Navigate to="vaults" replace />} />
            <Route path="vaults" element={<VaultsPage />} />
            <Route path="vaults/:vaultId/items" element={<ItemsPage />} />
            <Route path="vaults/:vaultId/encryption" element={<CloudEncryptionPage />} />
            <Route path="vaults/:vaultId/share" element={<VaultSharePage />} />
            <Route path="invitations" element={<InvitationsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
