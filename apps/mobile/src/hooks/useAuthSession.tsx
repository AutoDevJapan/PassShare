import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ConnectClient } from "@passshare/connect";
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
  clearAllSecureAuth,
  loadConnectToken,
  loadRefreshToken,
  saveConnectToken,
  saveRefreshToken,
} from "../lib/secure-storage";

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
  await saveRefreshToken(response.refreshToken);
  await saveConnectToken(response.connectAccessToken, response.connectExpiresAt);
  return new ConnectClient({
    host: getApiBaseUrl(),
    token: response.connectAccessToken,
  });
}

async function buildConnectClientFromStorage(): Promise<{
  user: AuthUser | null;
  client: ConnectClient | null;
}> {
  const refreshToken = await loadRefreshToken();
  if (!refreshToken) {
    return { user: null, client: null };
  }

  const user = await fetchCurrentUser(refreshToken);
  if (!user) {
    await clearAllSecureAuth();
    return { user: null, client: null };
  }

  let accessToken = await loadConnectToken();
  if (!accessToken) {
    const refreshed = await refreshConnectToken(refreshToken);
    accessToken = refreshed.connectAccessToken;
    await saveConnectToken(refreshed.connectAccessToken, refreshed.connectExpiresAt);
  }

  return {
    user,
    client: new ConnectClient({ host: getApiBaseUrl(), token: accessToken }),
  };
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);

  const refreshConnect = useCallback(async () => {
    setConnectLoading(true);
    try {
      const { user: currentUser, client } = await buildConnectClientFromStorage();
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
    const refreshToken = await loadRefreshToken();
    if (refreshToken) {
      try {
        await mobileLogout(refreshToken);
      } catch (error) {
        if (!(error instanceof AuthApiError)) {
          throw error;
        }
      }
    }
    await clearAllSecureAuth();
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
