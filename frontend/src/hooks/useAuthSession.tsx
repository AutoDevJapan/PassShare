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
import { lockCloudUi } from "../lib/cloud-worker";
import {
  authFetch,
  fetchCurrentUser,
  getApiBaseUrl,
  login as loginRequest,
  logout as logoutRequest,
  primeCsrfToken,
  signup as signupRequest,
  type AuthUser,
  type ConnectTokenResponse,
} from "../lib/auth-api";

type AuthSessionContextValue = {
  user: AuthUser | null;
  loading: boolean;
  connectClient: ConnectClient | null;
  connectLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: (fromLocationKey?: string) => Promise<void>;
  logoutLocationKey: string | null;
  refresh: () => Promise<void>;
  refreshConnect: () => Promise<ConnectClient | null>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [logoutLocationKey, setLogoutLocationKey] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const currentAccount = useRef<string | null>(null);

  const invalidate = useCallback(() => {
    const token = ++generation.current;
    lockCloudUi();
    setConnectClient(null);
    return token;
  }, []);

  const syncSession = useCallback(async (token: number): Promise<ConnectClient | null> => {
    const active = () => mounted.current && generation.current === token;
    const currentUser = await fetchCurrentUser();
    if (!active()) return null;
    // Compare identity before publishing any state or acquiring new credentials.
    // A valid same-account refresh keeps the opened worker and its draft alive.
    if (!currentUser || currentAccount.current !== currentUser.id) {
      lockCloudUi();
      setConnectClient(null);
    }
    currentAccount.current = currentUser?.id ?? null;
    setLogoutLocationKey(null);
    setUser(currentUser);
    if (!currentUser) return null;
    // fetchConnectToken's error does not expose HTTP status. Inspect the real
    // response here so a confirmed unauthorized result cannot retain secrets.
    const response = await authFetch("/api/auth/connect-token");
    if (!active()) return null;
    if (response.status === 401 || response.status === 403) {
      lockCloudUi();
      currentAccount.current = null;
      setConnectClient(null);
      setUser(null);
      return null;
    }
    if (!response.ok) throw new Error("Connect credential refresh failed");
    const credentials = await response.json() as ConnectTokenResponse;
    if (!active()) return null;
    const client = new ConnectClient({ host: getApiBaseUrl(), token: credentials.accessToken });
    setConnectClient(client);
    return client;
  }, []);

  const refreshConnect = useCallback(async () => {
    const token = ++generation.current;
    setLoading(currentAccount.current === null);
    setConnectLoading(true);
    try {
      return await syncSession(token);
    } catch {
      return null;
    } finally {
      if (mounted.current && generation.current === token) {
        setLoading(false);
        setConnectLoading(false);
      }
    }
  }, [syncSession]);

  const refresh = useCallback(async () => {
    const token = ++generation.current;
    // ProtectedRoute replaces its outlet while loading. Keep the current
    // account mounted until the identity check confirms a boundary change.
    setLoading(currentAccount.current === null);
    setConnectLoading(true);
    try {
      await syncSession(token);
      if (mounted.current && generation.current === token) await primeCsrfToken();
    } catch {
      // Temporary failures retain only the currently confirmed account. Both
      // identity and credential responses clear it on confirmed unauthorized.
    } finally {
      if (mounted.current && generation.current === token) {
        setLoading(false);
        setConnectLoading(false);
      }
    }
  }, [syncSession]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; ++generation.current; lockCloudUi(); };
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const token = invalidate();
      currentAccount.current = null;
      setUser(null);
      setLoading(true);
      setConnectLoading(true);
      try {
        const currentUser = await loginRequest(email, password);
        if (!mounted.current || generation.current !== token) return;
        currentAccount.current = currentUser.id;
        setUser(currentUser);
        await syncSession(token).catch(() => null);
      } finally {
        if (mounted.current && generation.current === token) { setLoading(false); setConnectLoading(false); }
      }
    },
    [invalidate, syncSession],
  );

  const signup = useCallback(
    async (email: string, password: string) => {
      const token = invalidate();
      currentAccount.current = null;
      setUser(null);
      setLoading(true);
      setConnectLoading(true);
      try {
        const currentUser = await signupRequest(email, password);
        if (!mounted.current || generation.current !== token) return;
        currentAccount.current = currentUser.id;
        setUser(currentUser);
        await syncSession(token).catch(() => null);
      } finally {
        if (mounted.current && generation.current === token) { setLoading(false); setConnectLoading(false); }
      }
    },
    [invalidate, syncSession],
  );

  const logout = useCallback(async (fromLocationKey?: string) => {
    const token = invalidate();
    setLoading(false);
    setConnectLoading(false);
    await logoutRequest();
    if (!mounted.current || generation.current !== token) return;
    // One route guard owns the destination after confirmed sign-out. Bind it
    // to the requesting page so a late response cannot redirect a new page.
    setLogoutLocationKey(fromLocationKey ?? null);
    currentAccount.current = null;
    setUser(null);
    await primeCsrfToken();
  }, [invalidate]);

  const value = useMemo(
    () => ({
      user,
      loading,
      connectClient,
      connectLoading,
      logoutLocationKey,
      login,
      signup,
      logout,
      refresh,
      refreshConnect,
    }),
    [user, loading, connectClient, connectLoading, logoutLocationKey, login, signup, logout, refresh, refreshConnect],
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
