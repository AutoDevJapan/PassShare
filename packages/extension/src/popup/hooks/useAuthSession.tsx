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
  loadStoredConnectToken,
  saveConnectToken,
  saveRefreshToken,
} from "../../lib/storage";
import { bootstrapConnectSession } from "@shared/lib/connect-session";

type AuthSessionContextValue = {
  user: AuthUser | null;
  loading: boolean;
  connectClient: ConnectClient | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

async function buildConnectClientFromStorage(): Promise<{
  user: AuthUser | null;
  client: ConnectClient | null;
}> {
  const result = await bootstrapConnectSession(
    {
      async load() {
        const refreshToken = await loadRefreshToken();
        if (!refreshToken) {
          return null;
        }
        const connect = await loadStoredConnectToken();
        return {
          refreshToken,
          connectAccessToken: connect?.token ?? "",
          connectExpiresAt: connect?.expiresAt ?? "",
        };
      },
      save: (session) => saveConnectToken(session.connectAccessToken, session.connectExpiresAt),
      clear: clearAllAuthStorage,
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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const { user: storedUser, client } = await buildConnectClientFromStorage();
        setUser(storedUser);
        setConnectClient(client);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const applyAuth = useCallback(async (response: TokenAuthResponse) => {
    await persistAuthSession(response);
    setUser(response.user);
    setConnectClient(
      new ConnectClient({ host: getApiBaseUrl(), token: response.connectAccessToken }),
    );
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      try {
        await applyAuth(await extensionLogin(email, password));
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
      try {
        await applyAuth(await extensionSignup(email, password));
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
    const refreshToken = await loadRefreshToken();
    if (refreshToken) {
      try {
        await extensionLogout(refreshToken);
      } catch {
        // Clear local state even if remote logout fails.
      }
    }
    await clearAllAuthStorage();
    setUser(null);
    setConnectClient(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, connectClient, login, signup, logout }),
    [user, loading, connectClient, login, signup, logout],
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
