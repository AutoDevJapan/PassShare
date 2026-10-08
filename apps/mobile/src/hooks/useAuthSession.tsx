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
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "@shared/i18n/I18nProvider";
import { bindNativeLock, type NativeStatus } from "@shared/lib/native-lock";
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
  unlocked: boolean;
  lockGeneration: number;
  beginUnlock: () => Promise<number>;
  completeUnlock: (epoch: number) => Promise<boolean>;
  biometricUnlock: () => Promise<boolean>;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshConnect: () => Promise<ConnectClient | null>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

async function persistAuthSession(response: MobileAuthResponse, isCurrent: () => boolean): Promise<ConnectClient> {
  try {
    await saveAuthSession({
      refreshToken: response.refreshToken,
      connectAccessToken: response.connectAccessToken,
      connectExpiresAt: response.connectExpiresAt,
    }, isCurrent);
  } catch (error) {
    await mobileLogout(response.refreshToken).catch(() => undefined);
    throw error;
  }
  return new ConnectClient({
    host: getApiBaseUrl(),
    token: response.connectAccessToken,
  });
}

async function buildConnectClientFromStorage(reason: string, isCurrent: () => boolean): Promise<{
  user: AuthUser | null;
  client: ConnectClient | null;
  refreshToken: string | null;
}> {
  let refreshToken: string | null = null;
  const result = await bootstrapConnectSession(
    {
      // Single biometric unlock: the whole session comes back in one read.
      load: async () => {
        const session = await loadAuthSession(reason);
        refreshToken = session?.refreshToken ?? null;
        return session;
      },
      save: (session) => saveAuthSession(session, isCurrent),
      clear: () => clearAuthSession(isCurrent),
    },
    { fetchCurrentUser, refreshConnectToken },
  );

  if (!result) {
    return { user: null, client: null, refreshToken: null };
  }

  return {
    user: result.user,
    refreshToken,
    client: new ConnectClient({ host: getApiBaseUrl(), token: result.accessToken }),
  };
}

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectClient, setConnectClient] = useState<ConnectClient | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [lockGeneration, setLockGeneration] = useState(0);
  // Bumped on every lock; async auth results that started before it are dropped.
  const generation = useRef(0);
  const nativeLock = useRef<ReturnType<typeof bindNativeLock> | null>(null);
  const authAttempt = useRef(0);
  const sessionRevision = useRef(0);
  const loggingOut = useRef<number | null>(null);
  const refreshFlight = useRef<{ generation: number; attempt: number; promise: Promise<ConnectClient | null> } | null>(null);
  const unlockAttempt = useRef<{ epoch: number; generation: number } | null>(null);
  const restoredProof = useRef<{ epoch: number; generation: number; attempt: number } | null>(null);
  const logoutBoundary = useRef<Promise<void>>(Promise.resolve());
  const logoutToken = useRef<string | null>(null);
  const userRef = useRef(user);
  userRef.current = user;
  const clientRef = useRef<ConnectClient | null>(null);
  clientRef.current = connectClient;

  const lock = useCallback(() => {
    setLockGeneration((value) => value + 1);
    setUnlocked(false);
    generation.current += 1;
    unlockAttempt.current = null;
    restoredProof.current = null;
    clientRef.current = null;
    logoutToken.current = null;
    setConnectClient(null);
    setConnectLoading(false);
  }, []);

  // Reports the signed-in account to Rust. False when a lock happened since
  // `started`, so the caller must drop its result.
  const adoptAccount = useCallback(async (id: string | null, started: number, epoch: number) => {
    if (started !== generation.current || (id !== null && document.hidden)) return null;
    const binding = nativeLock.current;
    if (binding && isTauri()) {
      const status = await invoke<NativeStatus & { changed: boolean; accepted: boolean }>("native_account", { id, epoch });
      binding.accept(status);
      // A poll may have applied this exact account-change epoch first. Count
      // its one lock instead of exempting every lock during a boolean window.
      const applied = started + (status.changed ? 1 : 0);
      if (!status.accepted || generation.current !== applied || document.hidden) return null;
      const latest = await invoke<NativeStatus>("native_session_status");
      binding.accept(latest);
      return latest.epoch === status.epoch && generation.current === applied && !document.hidden ? applied : null;
    }
    return started === generation.current && (id === null || !document.hidden) ? started : null;
  }, []);

  const captureEpoch = useCallback(async (started: number) => {
    await logoutBoundary.current;
    if (started !== generation.current) throw new Error(biometricReasonRef.current);
    if (!isTauri()) return started;
    const status = await invoke<NativeStatus>("native_session_status");
    nativeLock.current?.accept(status);
    if (started !== generation.current) throw new Error(biometricReasonRef.current);
    return status.epoch;
  }, []);

  // Localised reason shown in the OS biometric prompt. Held in a ref so the
  // callbacks below can read the latest locale without being re-created.
  const biometricReasonRef = useRef(t("mobile.lock.biometricReason"));
  biometricReasonRef.current = t("mobile.lock.biometricReason");

  const refreshConnect = useCallback(() => {
    if (loggingOut.current === sessionRevision.current) return Promise.resolve(null);
    const pending = refreshFlight.current;
    if (pending?.generation === generation.current && pending.attempt === authAttempt.current) return pending.promise;
    let started = generation.current;
    const attempt = ++authAttempt.current;
    const revision = sessionRevision.current;
    const isSessionCurrent = () => revision === sessionRevision.current;
    const isCurrent = () => started === generation.current && attempt === authAttempt.current && isSessionCurrent() && !document.hidden;
    const promise = (async () => {
      setConnectLoading(true);
      try {
        const epoch = await captureEpoch(started);
        const { user: currentUser, client, refreshToken } = await buildConnectClientFromStorage(
          biometricReasonRef.current, isSessionCurrent,
        );
        if (!isCurrent()) return null;
        const applied = await adoptAccount(currentUser?.id ?? null, started, epoch);
        if (applied === null || !isSessionCurrent() || attempt !== authAttempt.current) return null;
        restoredProof.current = { epoch: epoch + (applied - started), generation: applied, attempt };
        if (refreshFlight.current?.attempt === attempt) refreshFlight.current.generation = applied;
        started = applied;
        logoutToken.current = refreshToken;
        setUser(currentUser);
        clientRef.current = client;
        setConnectClient(client);
        return client;
      } catch {
        if (isCurrent()) setConnectClient(null);
        return null;
      } finally {
        if (attempt === authAttempt.current) setConnectLoading(false);
      }
    })();
    const flight = { generation: started, attempt, promise };
    refreshFlight.current = flight;
    void promise.finally(() => {
      if (refreshFlight.current === flight) refreshFlight.current = null;
    });
    return promise;
  }, [adoptAccount, captureEpoch]);

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

  const prepareSignIn = useCallback(async () => {
    await logoutBoundary.current;
    if (isTauri()) {
      const status = await invoke<NativeStatus>("native_lock");
      nativeLock.current?.accept(status);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    lock();
    const revision = ++sessionRevision.current;
    loggingOut.current = null;
    const attempt = ++authAttempt.current;
    const isSessionCurrent = () => revision === sessionRevision.current;
    await prepareSignIn();
    if (!isSessionCurrent()) throw new Error(biometricReasonRef.current);
    let started = generation.current;
    const isCurrent = () => started === generation.current && attempt === authAttempt.current && !document.hidden;
    const epoch = await captureEpoch(started);
    const response = await mobileLogin(email, password);
    const applied = isCurrent() ? await adoptAccount(response.user.id, started, epoch) : null;
    if (applied === null || !isSessionCurrent()) {
      await mobileLogout(response.refreshToken).catch(() => undefined);
      throw new Error(biometricReasonRef.current);
    }
    started = applied;
    const client = await persistAuthSession(response, isSessionCurrent);
    if (!isCurrent()) return;
    setUser(response.user);
    logoutToken.current = response.refreshToken;
    clientRef.current = client;
    setConnectClient(client);
  }, [adoptAccount, captureEpoch, lock, prepareSignIn]);

  const signup = useCallback(async (email: string, password: string) => {
    lock();
    const revision = ++sessionRevision.current;
    loggingOut.current = null;
    const attempt = ++authAttempt.current;
    const isSessionCurrent = () => revision === sessionRevision.current;
    await prepareSignIn();
    if (!isSessionCurrent()) throw new Error(biometricReasonRef.current);
    let started = generation.current;
    const isCurrent = () => started === generation.current && attempt === authAttempt.current && !document.hidden;
    const epoch = await captureEpoch(started);
    const response = await mobileSignup(email, password);
    const applied = isCurrent() ? await adoptAccount(response.user.id, started, epoch) : null;
    if (applied === null || !isSessionCurrent()) {
      await mobileLogout(response.refreshToken).catch(() => undefined);
      throw new Error(biometricReasonRef.current);
    }
    started = applied;
    const client = await persistAuthSession(response, isSessionCurrent);
    if (!isCurrent()) return;
    setUser(response.user);
    logoutToken.current = response.refreshToken;
    clientRef.current = client;
    setConnectClient(client);
  }, [adoptAccount, captureEpoch, lock, prepareSignIn]);

  const logout = useCallback(async () => {
    const knownToken = logoutToken.current;
    lock();
    authAttempt.current += 1;
    const revision = ++sessionRevision.current;
    loggingOut.current = revision;
    const isCurrent = () => revision === sessionRevision.current;
    setUser(null);
    setConnectLoading(false);
    // The server logout continues even if native IPC fails or background locks
    // the UI. New auth waits for the native boundary before taking an epoch.
    const native = isTauri() ? invoke<void>("native_logout") : Promise.resolve();
    logoutBoundary.current = native.catch(() => undefined);
    void native.catch(() => undefined);
    try {
      const token = knownToken ?? (await loadAuthSession(biometricReasonRef.current))?.refreshToken;
      if (token && (knownToken !== null || isCurrent())) {
        await mobileLogout(token);
      }
    } catch (error) {
      if (!(error instanceof AuthApiError)) throw error;
    } finally {
      try {
        await clearAuthSession(isCurrent);
      } finally {
        try {
          await native;
        } finally {
          if (loggingOut.current === revision) loggingOut.current = null;
        }
      }
    }
  }, [lock]);

  const beginUnlock = useCallback(
    async () => {
      const started = generation.current;
      const epoch = isTauri() ? await invoke<number>("native_begin_unlock") : started;
      if (started !== generation.current || document.hidden) throw new Error(biometricReasonRef.current);
      unlockAttempt.current = { epoch, generation: started };
      return epoch;
    },
    [],
  );

  // Only a native-accepted unlock (no lock transition since `beginUnlock`) opens the UI.
  const completeUnlock = useCallback(
    async (epoch: number) => {
      const started = generation.current;
      if (document.hidden || unlockAttempt.current?.epoch !== epoch || unlockAttempt.current.generation !== started) return false;
      unlockAttempt.current = null;
      const binding = nativeLock.current;
      if (binding && isTauri()) {
        const status = await invoke<NativeStatus>("native_complete_unlock", { epoch });
        binding.accept(status);
        if (!status.unlocked) return false;
      } else if (epoch !== started) {
        return false;
      }
      if (started !== generation.current || document.hidden) return false;
      setUnlocked(true);
      if (!clientRef.current) void refreshConnect();
      return true;
    },
    [refreshConnect],
  );

  // The plugin's standalone authenticate() launches a separate Android
  // Activity. Secure getData() instead authenticates within the app Activity.
  // No general exception to background/resume invalidation is introduced.
  const biometricUnlock = useCallback(async () => {
    const client = await refreshConnect();
    const proof = restoredProof.current;
    if (!client || !proof || proof.attempt !== authAttempt.current || proof.generation !== generation.current || document.hidden) return false;
    // Adopt the account first, but keep the epoch of the successful secure
    // read. Taking a new epoch here could bless a background after that proof.
    unlockAttempt.current = { epoch: proof.epoch, generation: proof.generation };
    return completeUnlock(proof.epoch);
  }, [refreshConnect, completeUnlock]);

  useEffect(() => {
    const binding = bindNativeLock(isTauri() ? { invoke, listen } : null, lock);
    nativeLock.current = binding;
    // Real app background only. Window blur from the OS biometric dialog does not
    // change visibility and is intentionally not a lock trigger.
    const onVisibility = () => {
      lock();
      const transition = isTauri() ? invoke<void>(document.hidden ? "native_background" : "native_foreground") : Promise.resolve();
      void transition.then(() => {
        if (!document.hidden && userRef.current === null && loggingOut.current !== sessionRevision.current) void refreshConnect();
      }).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) onVisibility();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      binding.dispose();
      nativeLock.current = null;
      generation.current += 1;
      authAttempt.current += 1;
      sessionRevision.current += 1;
      unlockAttempt.current = null;
      restoredProof.current = null;
      logoutToken.current = null;
    };
  }, [lock, refreshConnect]);

  const value = useMemo(
    () => ({
      user,
      loading,
      connectClient,
      connectLoading,
      unlocked,
      lockGeneration,
      beginUnlock,
      completeUnlock,
      biometricUnlock,
      login,
      signup,
      logout,
      refresh,
      refreshConnect,
    }),
    [
      user,
      loading,
      connectClient,
      connectLoading,
      unlocked,
      lockGeneration,
      beginUnlock,
      completeUnlock,
      biometricUnlock,
      login,
      signup,
      logout,
      refresh,
      refreshConnect,
    ],
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
