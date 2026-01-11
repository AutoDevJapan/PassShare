/**
 * API Client for PassShare Backend
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/v1';

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.token = localStorage.getItem('access_token');
  }

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('access_token', token);
    } else {
      localStorage.removeItem('access_token');
    }
  }

  getToken(): string | null {
    return this.token;
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { skipAuth, ...fetchOptions } = options;

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {}),
    };

    if (!skipAuth && this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...fetchOptions,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.setToken(null);
        window.dispatchEvent(new CustomEvent('auth:logout'));
      }
      const error = await response.json().catch(() => ({ detail: 'An error occurred' }));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  // Auth endpoints
  async register(username: string, password: string, gpgKeyId?: string) {
    return this.request<{ id: number; username: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, gpg_key_id: gpgKeyId }),
      skipAuth: true,
    });
  }

  async login(username: string, password: string) {
    const response = await this.request<{
      access_token: string;
      token_type: string;
      expires_in: number;
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      skipAuth: true,
    });
    this.setToken(response.access_token);
    return response;
  }

  async logout() {
    this.setToken(null);
  }

  async getMe() {
    return this.request<{
      id: number;
      username: string;
      gpg_key_id: string | null;
      created_at: string;
    }>('/auth/me');
  }

  // Secret endpoints
  async listSecrets(prefix = '') {
    const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return this.request<{
      secrets: SecretListItem[];
      total: number;
    }>(`/secrets${params}`);
  }

  async getSecret(name: string) {
    return this.request<SecretDetail>(`/secrets/${encodeURIComponent(name)}`);
  }

  async createSecret(data: CreateSecretData) {
    return this.request<SecretDetail>('/secrets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSecret(name: string, data: UpdateSecretData) {
    return this.request<SecretDetail>(`/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteSecret(name: string) {
    return this.request<void>(`/secrets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  async generatePassword(data: GeneratePasswordData) {
    return this.request<{ name: string; password: string }>('/secrets/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generateStandalonePassword(data: StandalonePasswordData) {
    return this.request<{ passwords: string[] }>('/secrets/pwgen', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async searchSecrets(query: string, searchContent = false) {
    return this.request<{ matches: string[]; total: number }>('/secrets/search', {
      method: 'POST',
      body: JSON.stringify({ query, search_content: searchContent }),
    });
  }

  async syncStore(store?: string) {
    return this.request<{ success: boolean; message: string }>('/secrets/sync', {
      method: 'POST',
      body: JSON.stringify({ store }),
    });
  }

  async getOtp(name: string) {
    return this.request<{ otp: string }>(`/secrets/${encodeURIComponent(name)}/otp`);
  }

  async getHistory(name: string, count = 10) {
    return this.request<HistoryEntry[]>(
      `/secrets/${encodeURIComponent(name)}/history?count=${count}`
    );
  }

  async auditPasswords(folder = '') {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    return this.request<AuditResponse>(`/secrets/audit${params}`);
  }

  // Config endpoints
  async getConfig() {
    return this.request<ConfigResponse>('/secrets/config');
  }

  async updateConfig(data: Partial<ConfigResponse>) {
    return this.request<ConfigResponse>('/secrets/config', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Mounts endpoints
  async getMounts() {
    return this.request<MountResponse[]>('/secrets/mounts');
  }

  async addMount(alias: string, path: string) {
    return this.request<MountResponse>('/secrets/mounts', {
      method: 'POST',
      body: JSON.stringify({ alias, path }),
    });
  }

  async removeMount(alias: string) {
    return this.request<void>(`/secrets/mounts/${encodeURIComponent(alias)}`, {
      method: 'DELETE',
    });
  }

  // Recipients endpoints
  async getRecipients(store?: string) {
    const params = store ? `?store=${encodeURIComponent(store)}` : '';
    return this.request<RecipientResponse[]>(`/secrets/recipients${params}`);
  }

  async addRecipient(keyId: string, store?: string) {
    return this.request<{ message: string }>('/secrets/recipients', {
      method: 'POST',
      body: JSON.stringify({ key_id: keyId, store }),
    });
  }

  async removeRecipient(keyId: string, store?: string) {
    const params = store ? `?store=${encodeURIComponent(store)}` : '';
    return this.request<void>(`/secrets/recipients/${encodeURIComponent(keyId)}${params}`, {
      method: 'DELETE',
    });
  }
}

// Types
export interface SecretListItem {
  name: string;
  has_otp: boolean;
  has_notes: boolean;
  keys: string[];
  modified_at?: string;
}

export interface SecretDetail {
  name: string;
  password: string;
  data: Record<string, string>;
  notes: string | null;
  has_otp: boolean;
  otp_code: string | null;
  modified_at?: string;
}

export interface CreateSecretData {
  name: string;
  password: string;
  data?: Record<string, string>;
  notes?: string;
}

export interface UpdateSecretData {
  password?: string;
  data?: Record<string, string>;
  notes?: string;
}

export interface GeneratePasswordData {
  name: string;
  length?: number;
  symbols?: boolean;
  xkcd?: boolean;
  force?: boolean;
}

export interface StandalonePasswordData {
  length?: number;
  symbols?: boolean;
  xkcd?: boolean;
  count?: number;
}

export interface HistoryEntry {
  revision: string;
  date: string;
  message: string;
  author?: string;
}

export interface AuditResponse {
  total_secrets: number;
  weak_passwords: {
    name: string;
    strength: string;
    entropy: number;
    issues: string[];
  }[];
  duplicates: string[][];
}

export interface ConfigResponse {
  path: string;
  autoclip: boolean;
  cliptimeout: number;
  autosync: boolean;
  autopush: boolean;
  mounts: Record<string, string>;
}

export interface MountResponse {
  alias: string;
  path: string;
}

export interface RecipientResponse {
  key_id: string;
  name?: string;
  email?: string;
}

export const api = new ApiClient(API_BASE_URL);
export default api;
