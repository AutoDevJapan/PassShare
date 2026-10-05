import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConnectClient } from "@passshare/connect";
import { useI18n } from "@shared/i18n/I18nProvider";
import {
  AuthApiError,
  fetchCurrentUser,
  getApiBaseUrl,
  mobileLogin,
  mobileLogout,
  mobileSignup,
  refreshConnectToken,
  type AuthUser,
  type MobileAuthResponse,
} from "../lib/auth-api";
import {
  clearAuthSession,
  loadAuthSession,
  saveAuthSession,
} from "../lib/secure-storage";
import { bootstrapConnectSession } from "@shared/lib/connect-session";

type AuthSessionContextValue = {
  user: AuthUser | null;
  loading: boolean;
  connectClient: ConnectClient | null;
  connectLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshConnect: () => Promise<ConnectClient | null>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

async function persistAuthSession(response: MobileAuthResponse): Promise<ConnectClient> {
  await saveAuthSession({
    refreshToken: response.refreshToken,
    connectAccessToken: response.connectAccessToken,
    connectExpiresAt: response.connectExpiresAt,
  });
  return new ConnectClient({
    host: getApiBaseUrl(),
    token: response.connectAccessToken,
  });
}

async function buildConnectClientFromStorage(reason: string): Promise<{
  user: AuthUser | null;
  client: ConnectClient | null;
}> {
  const result = await bootstrapConnectSession(
    {
      // Single biometric unlock: the whole session comes back in one read.
      load: () => loadAuthSession(reason),
      save: saveAuthSession,
      clear: clearAuthSession,
    },
    { fetchCurrentUser, refreshConnectToken },
  );

  if (!result) {
    return { user: null, client: null };
  }

  return {
    user: result.user,
    client: new ConnectClient({ host: getApiBaseUrl(), token: result.accessToken }),
  };
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);

  // Localised reason shown in the OS biometric prompt. Held in a ref so the
  // callbacks below can read the latest locale without being re-created.
  const biometricReasonRef = useRef(t("mobile.lock.biometricReason"));
  biometricReasonRef.current = t("mobile.lock.biometricReason");

  const refreshConnect = useCallback(async () => {
    setConnectLoading(true);
    try {
      const { user: currentUser, client } = await buildConnectClientFromStorage(
        biometricReasonRef.current,
      );
      setUser(currentUser);
      setConnectClient(client);
      return client;
    } catch {
      setConnectClient(null);
      return null;
    } finally {
      setConnectLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await refreshConnect();
    } finally {
      setLoading(false);
    }
  }, [refreshConnect]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const response = await mobileLogin(email, password);
    const client = await persistAuthSession(response);
    setUser(response.user);
    setConnectClient(client);
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const response = await mobileSignup(email, password);
    const client = await persistAuthSession(response);
    setUser(response.user);
    setConnectClient(client);
  }, []);

  const logout = useCallback(async () => {
    const session = await loadAuthSession(biometricReasonRef.current);
    if (session?.refreshToken) {
      try {
        await mobileLogout(session.refreshToken);
      } catch (error) {
        if (!(error instanceof AuthApiError)) {
          throw error;
        }
      }
    }
    await clearAuthSession();
    setUser(null);
    setConnectClient(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      connectClient,
      connectLoading,
      login,
      signup,
      logout,
      refresh,
      refreshConnect,
    }),
    [user, loading, connectClient, connectLoading, login, signup, logout, refresh, refreshConnect],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionContextValue {
  const context = useContext(AuthSessionContext);
  if (!context) {
    throw new Error("useAuthSession must be used within AuthSessionProvider");
  }
  return context;
}
