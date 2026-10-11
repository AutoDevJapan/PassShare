import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { ConnectClient } from "@passshare/connect";
import { persistAuthSession } from "../../lib/session-persist";
import {
  AuthApiError,
  extensionLogin,
  extensionLogout,
  extensionSignup,
  fetchCurrentUser,
  getApiBaseUrl,
  refreshConnectToken,
  type AuthUser,
  type TokenAuthResponse,
} from "../../lib/auth-api";
import {
  clearAllAuthStorage,
  loadRefreshToken,
  loadStoredAuthSession,
  saveConnectToken,
} from "../../lib/storage";
import { bootstrapConnectSession } from "@shared/lib/connect-session";
import { createCloudSession, type CloudSession } from "@shared/cloud/session-transport";

type AuthSessionContextValue = {
  user: AuthUser | null;
  loading: boolean;
  connectClient: ConnectClient | null;
  cloudSession: CloudSession | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

async function buildConnectClientFromStorage(isCurrent: () => boolean): Promise<{
  user: AuthUser | null;
  client: ConnectClient | null;
  refreshToken: string | null;
}> {
  let heldToken: string | null = null;
  const result = await bootstrapConnectSession(
    {
      async load() {
        const session = await loadStoredAuthSession();
        heldToken = session?.refreshToken ?? null;
        return session;
      },
      save: (session) => saveConnectToken(session.connectAccessToken, session.connectExpiresAt, session.refreshToken, isCurrent),
      clear: () => clearAllAuthStorage(heldToken ?? undefined, isCurrent),
    },
    { fetchCurrentUser, refreshConnectToken },
  );

  if (!result || !isCurrent() || await loadRefreshToken() !== heldToken) {
    return { user: null, client: null, refreshToken: null };
  }

  return {
    user: result.user,
    refreshToken: heldToken,
    client: new ConnectClient({ host: getApiBaseUrl(), token: result.accessToken }),
  };
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [loading, setLoading] = useState(true);
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(null);
  const cloudRef = useRef<CloudSession | null>(null);
  const generation = useRef(0);
  const installedToken = useRef<string | null>(null);
  function clearCloud() {
    ++generation.current; installedToken.current = null;
    cloudRef.current?.dispose(); cloudRef.current = null; setCloudSession(null);
    window.dispatchEvent(new Event("passshare:cloud-lock"));
  }
  function bindCloud(id: string, token: string, epoch: number) {
    installedToken.current = token;
    cloudRef.current = createCloudSession(getApiBaseUrl(), id, token, () => epoch === generation.current);
    setCloudSession(cloudRef.current);
  }

  useEffect(() => {
    const epoch = generation.current;
    void (async () => {
      try {
        const { user: storedUser, client, refreshToken } = await buildConnectClientFromStorage(() => epoch === generation.current);
        if (epoch !== generation.current) return;
        if (storedUser && refreshToken) bindCloud(storedUser.id, refreshToken, epoch);
        setUser(storedUser);
        setConnectClient(client);
      } finally {
        if (epoch === generation.current) setLoading(false);
      }
    })();
    return () => { ++generation.current; cloudRef.current?.dispose(); cloudRef.current = null; };
  }, []);

  useEffect(() => {
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && installedToken.current && changes["passshare.refreshToken"] &&
        changes["passshare.refreshToken"].newValue !== installedToken.current) {
        clearCloud(); setUser(null); setConnectClient(null);
      }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);

  const applyAuth = useCallback(async (response: TokenAuthResponse, epoch: number) => {
    if (epoch !== generation.current) { await extensionLogout(response.refreshToken).catch(() => {}); return; }
    const saved = await persistAuthSession(response, () => epoch === generation.current);
    if (!saved) { await extensionLogout(response.refreshToken).catch(() => {}); return; }
    if (epoch !== generation.current) {
      await clearAllAuthStorage(response.refreshToken);
      await extensionLogout(response.refreshToken).catch(() => {});
      return;
    }
    bindCloud(response.user.id, response.refreshToken, epoch);
    setUser(response.user);
    setConnectClient(
      new ConnectClient({ host: getApiBaseUrl(), token: response.connectAccessToken }),
    );
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      clearCloud();
      const epoch = generation.current;
      try {
        await applyAuth(await extensionLogin(email, password), epoch);
      } catch (error) {
        if (error instanceof AuthApiError) {
          throw error;
        }
        throw new AuthApiError("Login failed");
      }
    },
    [applyAuth],
  );

  const signup = useCallback(
    async (email: string, password: string) => {
      clearCloud();
      const epoch = generation.current;
      try {
        await applyAuth(await extensionSignup(email, password), epoch);
      } catch (error) {
        if (error instanceof AuthApiError) {
          throw error;
        }
        throw new AuthApiError("Signup failed");
      }
    },
    [applyAuth],
  );

  const logout = useCallback(async () => {
    clearCloud();
    setUser(null); setConnectClient(null);
    const epoch = generation.current;
    const refreshToken = await loadRefreshToken();
    if (refreshToken) {
      try {
        await extensionLogout(refreshToken);
      } catch {
        // Clear local state even if remote logout fails.
      }
    }
    await clearAllAuthStorage(refreshToken ?? undefined, () => epoch === generation.current);
    if (epoch === generation.current) { setUser(null); setConnectClient(null); }
  }, []);

  const value = useMemo(
    () => ({ user, loading, connectClient, cloudSession, login, signup, logout }),
    [user, loading, connectClient, cloudSession, login, signup, logout],
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
