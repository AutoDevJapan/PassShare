/**
 * Connect-session bootstrap shared by the browser extension (service worker +
 * popup) and the mobile app. Each client stores its refresh token / Connect
 * access token in a different backend (chrome.storage vs. biometric keychain),
 * so the storage is injected via {@link ConnectSessionStore} while the token
 * validity/refresh policy lives here once.
 *
 * Pure and dependency-free so it runs under `node --experimental-strip-types`.
 * Never returns or logs plaintext secrets beyond the access token the caller
 * needs to build its Connect client.
 */

/** A persisted Connect session: the long-lived refresh token plus the current Connect access token and its expiry. */
export type StoredConnectSession = {
  refreshToken: string;
  connectAccessToken: string;
  connectExpiresAt: string;
};

/**
 * Storage backend for the Connect session. `load` MUST read the session in a
 * single operation (the mobile keychain unlock is one biometric prompt), and
 * `save` persists a session whose Connect token was just refreshed.
 */
export type ConnectSessionStore = {
  load(): Promise<StoredConnectSession | null>;
  save(session: StoredConnectSession): Promise<void>;
  clear(): Promise<void>;
};

/** Auth API surface needed to validate the session and mint a fresh Connect token. */
export type ConnectSessionApi<TUser> = {
  fetchCurrentUser(refreshToken: string): Promise<TUser | null>;
  refreshConnectToken(
    refreshToken: string,
  ): Promise<{ connectAccessToken: string; connectExpiresAt: string }>;
};

export type BootstrappedConnectSession<TUser> = {
  user: TUser;
  accessToken: string;
};

/** Only an explicit, parseable future expiry permits reusing a cached token. */
export function isConnectTokenUsable(session: {
  connectAccessToken: string;
  connectExpiresAt: string;
}): boolean {
  if (!session.connectAccessToken) {
    return false;
  }
  const expiresAt = Date.parse(session.connectExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Resolve a usable Connect session from storage:
 * 1. Load the stored session; bail out if there is no refresh token.
 * 2. Validate the refresh token by fetching the current user; clear storage and
 *    bail if it is no longer valid.
 * 3. Reuse the stored Connect access token if still usable, otherwise refresh it
 *    and persist the new token.
 *
 * Returns the validated user and the access token to build a Connect client, or
 * `null` when no usable session exists.
 */
export async function bootstrapConnectSession<TUser>(
  store: ConnectSessionStore,
  api: ConnectSessionApi<TUser>,
  options: { forceRefresh?: boolean } = {},
): Promise<BootstrappedConnectSession<TUser> | null> {
  const session = await store.load();
  if (!session?.refreshToken) {
    return null;
  }

  const user = await api.fetchCurrentUser(session.refreshToken);
  if (!user) {
    await store.clear();
    return null;
  }

  let accessToken = session.connectAccessToken;
  if (options.forceRefresh || !isConnectTokenUsable(session)) {
    const refreshed = await api.refreshConnectToken(session.refreshToken);
    accessToken = refreshed.connectAccessToken;
    await store.save({
      refreshToken: session.refreshToken,
      connectAccessToken: refreshed.connectAccessToken,
      connectExpiresAt: refreshed.connectExpiresAt,
    });
  }

  return { user, accessToken };
}
