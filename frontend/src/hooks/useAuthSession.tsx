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

  const invalidate = useCallback((dropClient = true) => {
    const token = ++generation.current;
    lockCloudUi();
    if (dropClient) setConnectClient(null);
    return token;
  }, []);

  const syncSession = useCallback(async (token: number): Promise<ConnectClient | null> => {
    const active = () => mounted.current && generation.current === token;
    const currentUser = await fetchCurrentUser();
    if (!active()) return null;
    // Drop the previous account before acquiring credentials for the current one.
    if (currentAccount.current !== (currentUser?.id ?? null)) setConnectClient(null);
    currentAccount.current = currentUser?.id ?? null;
    setLogoutLocationKey(null);
    setUser(currentUser);
    if (!currentUser) return null;
    const credentials = await fetchConnectToken();
    if (!active()) return null;
    const client = new ConnectClient({ host: getApiBaseUrl(), token: credentials.accessToken });
    setConnectClient(client);
    return client;
  }, []);

  const refreshConnect = useCallback(async () => {
    const token = invalidate(false);
    setLoading(false);
    setConnectLoading(true);
    try {
      return await syncSession(token);
    } catch {
      return null;
    } finally {
      if (mounted.current && generation.current === token) setConnectLoading(false);
    }
  }, [invalidate, syncSession]);

  const refresh = useCallback(async () => {
    const token = invalidate(false);
    setLoading(true);
    setConnectLoading(true);
    try {
      await primeCsrfToken();
      if (mounted.current && generation.current === token) await syncSession(token);
    } catch {
      // Only fetchCurrentUser's confirmed 401 clears the session. A temporary
      // Connect credential failure keeps the user available for retry.
    } finally {
      if (mounted.current && generation.current === token) {
        setLoading(false);
        setConnectLoading(false);
      }
    }
  }, [invalidate, syncSession]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; ++generation.current; lockCloudUi(); };
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const token = invalidate();
      setUser(null);
      setLoading(true);
      setConnectLoading(true);
      try {
        const currentUser = await loginRequest(email, password);
        if (!mounted.current || generation.current !== token) return;
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
      setUser(null);
      setLoading(true);
      setConnectLoading(true);
      try {
        const currentUser = await signupRequest(email, password);
        if (!mounted.current || generation.current !== token) return;
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
