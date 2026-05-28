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

let csrfToken: string | null = null;

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
  const response = await fetch(`${API_BASE}/api/auth/csrf`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new AuthApiError("Failed to fetch CSRF token");
  }
  const body = (await response.json()) as CsrfResponse;
  csrfToken = body.csrfToken;
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

  return fetch(`${API_BASE}${path}`, {
    ...init,
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
  if (body.csrfToken) {
    csrfToken = body.csrfToken;
  }
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
  if (body.csrfToken) {
    csrfToken = body.csrfToken;
  }
  return body.user;
}

export async function logout(): Promise<void> {
  const response = await authFetch("/api/auth/logout", { method: "POST" });
  if (!response.ok && response.status !== 204) {
    return parseAuthError(response);
  }
  csrfToken = null;
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

export async function primeCsrfToken(): Promise<void> {
  await loadCsrfToken();
}

export function getApiBaseUrl(): string {
  return API_BASE;
}
