const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8080";
import { EXTENSION_CLIENT_HEADER, EXTENSION_CLIENT_VALUE } from "./constants";

export type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
};

export type TokenAuthResponse = {
  user: AuthUser;
  refreshToken: string;
  sessionExpiresAt: string;
  connectAccessToken: string;
  connectExpiresIn: number;
  connectExpiresAt: string;
};

export type ConnectTokenRefreshResponse = {
  sessionExpiresAt: string;
  connectAccessToken: string;
  connectExpiresIn: number;
  connectExpiresAt: string;
};

export class AuthApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthApiError";
  }
}

export function getApiBaseUrl(): string {
  return API_BASE.replace(/\/$/, "");
}

async function parseAuthError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new AuthApiError(body.message ?? "Request failed");
}

function extensionHeaders(refreshToken?: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [EXTENSION_CLIENT_HEADER]: EXTENSION_CLIENT_VALUE,
  };
  if (refreshToken) {
    headers.Authorization = `Bearer ${refreshToken}`;
  }
  return headers;
}

export async function extensionLogin(email: string, password: string): Promise<TokenAuthResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/login`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as TokenAuthResponse;
}

export async function extensionSignup(email: string, password: string): Promise<TokenAuthResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/signup`, {
    method: "POST",
    headers: extensionHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as TokenAuthResponse;
}

export async function fetchCurrentUser(refreshToken: string): Promise<AuthUser | null> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
    headers: extensionHeaders(refreshToken),
  });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    return parseAuthError(response);
  }
  const body = (await response.json()) as { user: AuthUser };
  return body.user;
}

export async function refreshConnectToken(
  refreshToken: string,
): Promise<ConnectTokenRefreshResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    return parseAuthError(response);
  }
  return (await response.json()) as ConnectTokenRefreshResponse;
}

export async function extensionLogout(refreshToken: string): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
    method: "POST",
    headers: extensionHeaders(refreshToken),
  });
  if (!response.ok && response.status !== 204) {
    return parseAuthError(response);
  }
}
