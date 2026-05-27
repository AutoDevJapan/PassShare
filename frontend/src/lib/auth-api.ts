const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
};

type AuthResponse = {
  user: AuthUser;
  sessionExpiresAt: string;
  csrfToken?: string;
};

type CsrfResponse = {
  csrfToken: string;
};

let csrfToken: string | null = null;

async function loadCsrfToken(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/auth/csrf`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch CSRF token");
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
    throw new Error("Failed to fetch current user");
  }
  const body = (await response.json()) as { user: AuthUser };
  return body.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const response = await authFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error("Login failed");
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
    throw new Error("Logout failed");
  }
  csrfToken = null;
}

export async function primeCsrfToken(): Promise<void> {
  await loadCsrfToken();
}
