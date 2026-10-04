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
  fetchConnectToken,
  fetchCurrentUser,
  getApiBaseUrl,
  login as loginRequest,
  logout as logoutRequest,
  primeCsrfToken,
  signup as signupRequest,
  type AuthUser,
} from "../lib/auth-api";

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

async function buildConnectClient(onUser: (user: AuthUser | null) => void): Promise<ConnectClient | null> {
  const user = await fetchCurrentUser();
  onUser(user);
  if (!user) {
    return null;
  }
  const token = await fetchConnectToken();
  return new ConnectClient({ host: getApiBaseUrl(), token: token.accessToken });
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);

  const refreshConnect = useCallback(async () => {
    setConnectLoading(true);
    try {
      const client = await buildConnectClient(setUser);
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
      await primeCsrfToken();
      const currentUser = await fetchCurrentUser();
      setUser(currentUser);
      if (currentUser) {
        await refreshConnect();
      } else {
        setConnectClient(null);
      }
    } finally {
      setLoading(false);
    }
  }, [refreshConnect]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      setUser(await loginRequest(email, password));
      await refreshConnect();
    },
    [refreshConnect],
  );

  const signup = useCallback(
    async (email: string, password: string) => {
      setUser(await signupRequest(email, password));
      await refreshConnect();
    },
    [refreshConnect],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
    setConnectClient(null);
    await primeCsrfToken();
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
