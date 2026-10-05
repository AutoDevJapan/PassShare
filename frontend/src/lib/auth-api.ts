const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
};

export type ConnectTokenResponse = {
  accessToken: string;
  expiresIn: number;
  expiresAt: string;
};

type AuthResponse = {
  user: AuthUser;
  sessionExpiresAt: string;
  csrfToken?: string;
};

type CsrfResponse = {
  csrfToken: string;
};

type AuthErrorBody = {
  message?: string;
  code?: string;
};

// Railway backend cold-starts (idle wake / fresh deploy) briefly have no healthy
// replica, so the edge proxy returns a transient 5xx before the container is
// listening. These retries absorb that window so the first request after idle
// does not surface as a user-visible "Failed to fetch". See issue #368.
const RETRY_MAX_ATTEMPTS = 4; // initial attempt + 3 retries
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 3000;
// A 5xx from the gateway means the request never reached app logic, so retrying
// is safe regardless of HTTP method.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function backoffDelayMs(attempt: number): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  // Full jitter avoids synchronized retry stampedes across tabs/clients.
  return exponential + Math.random() * RETRY_BASE_DELAY_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = IDEMPOTENT_METHODS.has(method);
  let lastError: unknown;

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt >= RETRY_MAX_ATTEMPTS - 1;
    try {
      const response = await fetch(input, init);
      if (RETRYABLE_STATUS.has(response.status) && !isLastAttempt) {
        await delay(backoffDelayMs(attempt));
        continue;
      }
      return response;
    } catch (error) {
      // Network-level failure (fetch throws, e.g. TypeError). Only retry
      // idempotent requests so a mutation that may already have been processed
      // is never double-submitted.
      lastError = error;
      if (!idempotent || isLastAttempt) {
        throw error;
      }
      await delay(backoffDelayMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}

export class AuthApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthApiError";
  }
}

async function parseAuthError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as AuthErrorBody;
  throw new AuthApiError(body.message ?? "Request failed");
}

async function loadCsrfToken(): Promise<string> {
  const response = await fetchWithRetry(`${API_BASE}/api/auth/csrf`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new AuthApiError("Failed to fetch CSRF token");
  }
  const body = (await response.json()) as CsrfResponse;
  return body.csrfToken;
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("X-CSRF-Token", await loadCsrfToken());
  }

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetchWithRetry(`${API_BASE}${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
  });
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const response = await authFetch("/api/auth/me");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as { user: AuthUser };
  return body.user;
}

export async function signup(email: string, password: string): Promise<AuthUser> {
  const response = await authFetch("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as AuthResponse;
  return body.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const response = await authFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as AuthResponse;
  return body.user;
}

export async function logout(): Promise<void> {
  const response = await authFetch("/api/auth/logout", { method: "POST" });
  if (!response.ok && response.status !== 204) {
    return parseAuthError(response);
  }
}

export async function fetchConnectToken(): Promise<ConnectTokenResponse> {
  const response = await authFetch("/api/auth/connect-token");
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as ConnectTokenResponse;
}

export async function createPasswordBox(name: string): Promise<{ vaultId: string; name: string }> {
  const response = await authFetch("/api/auth/vaults", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as { vaultId: string; name: string };
}

export type VaultMember = {
  userId: string;
  email: string;
  role: "owner" | "member";
  joinedAt: string;
};

export type ShareInvitation = {
  id: string;
  email?: string;
  vaultId?: string;
  vaultName?: string;
  inviterEmail?: string;
  role: string;
  expiresAt: string;
  createdAt?: string;
};

export async function listVaultMembers(vaultId: string): Promise<VaultMember[]> {
  const response = await authFetch(`/api/auth/vaults/${vaultId}/members`);
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as { members: VaultMember[] };
  return body.members;
}

export async function inviteToVault(vaultId: string, email: string): Promise<ShareInvitation> {
  const response = await authFetch(`/api/auth/vaults/${vaultId}/invitations`, {
    method: "POST",
    body: JSON.stringify({ email, role: "member" }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as ShareInvitation;
}

export async function listVaultInvitations(vaultId: string): Promise<ShareInvitation[]> {
  const response = await authFetch(`/api/auth/vaults/${vaultId}/invitations`);
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as { invitations: ShareInvitation[] };
  return body.invitations;
}

export async function revokeVaultInvitation(vaultId: string, invitationId: string): Promise<void> {
  const response = await authFetch(`/api/auth/vaults/${vaultId}/invitations/${invitationId}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 204) {
    return parseAuthError(response);
  }
}

export async function removeVaultMember(vaultId: string, userId: string): Promise<void> {
  const response = await authFetch(`/api/auth/vaults/${vaultId}/members/${userId}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 204) {
    return parseAuthError(response);
  }
}

export async function listPendingInvitations(): Promise<ShareInvitation[]> {
  const response = await authFetch("/api/auth/invitations");
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as { invitations: ShareInvitation[] };
  return body.invitations;
}

export async function acceptInvitation(invitationId: string): Promise<{ vaultId: string; role: string }> {
  const response = await authFetch(`/api/auth/invitations/${invitationId}/accept`, {
    method: "POST",
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as { vaultId: string; role: string };
}

export async function declineInvitation(invitationId: string): Promise<void> {
  const response = await authFetch(`/api/auth/invitations/${invitationId}/decline`, {
    method: "POST",
  });
  if (!response.ok && response.status !== 204) {
    return parseAuthError(response);
  }
}

export async function primeCsrfToken(): Promise<void> {
  await loadCsrfToken();
}

export function getApiBaseUrl(): string {
  return API_BASE;
}
