/**
 * API Service for PassShare Mobile
 *
 * Connects to the PassShare backend API for vault operations
 */

import * as SecureStore from 'expo-secure-store';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.pass-share.bm1314.net/api/v1';

class ApiService {
  private token: string | null = null;

  async init(): Promise<void> {
    this.token = await SecureStore.getItemAsync('access_token');
  }

  async setToken(token: string | null): Promise<void> {
    this.token = token;
    if (token) {
      await SecureStore.setItemAsync('access_token', token);
    } else {
      await SecureStore.deleteItemAsync('access_token');
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
    options: RequestInit = {}
  ): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        await this.setToken(null);
      }
      const error = await response.json().catch(() => ({ detail: 'An error occurred' }));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  }

  // Auth
  async login(username: string, password: string): Promise<void> {
    const response = await this.request<{
      access_token: string;
      token_type: string;
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    await this.setToken(response.access_token);
  }

  async register(username: string, password: string, gpgKeyId?: string): Promise<void> {
    await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, gpg_key_id: gpgKeyId }),
    });
    await this.login(username, password);
  }

  async logout(): Promise<void> {
    await this.setToken(null);
  }

  async getMe(): Promise<{
    id: number;
    username: string;
    gpg_key_id: string | null;
    created_at: string;
  }> {
    return this.request('/auth/me');
  }

  // Secrets
  async listSecrets(prefix = ''): Promise<{
    secrets: SecretListItem[];
    total: number;
  }> {
    const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return this.request(`/secrets${params}`);
  }

  async getSecret(name: string): Promise<SecretDetail> {
    return this.request(`/secrets/${encodeURIComponent(name)}`);
  }

  async createSecret(data: {
    name: string;
    password: string;
    data?: Record<string, string>;
    notes?: string;
  }): Promise<SecretDetail> {
    return this.request('/secrets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateSecret(
    name: string,
    data: {
      password?: string;
      data?: Record<string, string>;
      notes?: string;
    }
  ): Promise<SecretDetail> {
    return this.request(`/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteSecret(name: string): Promise<void> {
    return this.request(`/secrets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  async generatePassword(data: {
    name: string;
    length?: number;
    symbols?: boolean;
    xkcd?: boolean;
    force?: boolean;
  }): Promise<{ name: string; password: string }> {
    return this.request('/secrets/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async generateStandalonePassword(data: {
    length?: number;
    symbols?: boolean;
    xkcd?: boolean;
    count?: number;
  }): Promise<{ passwords: string[] }> {
    return this.request('/secrets/pwgen', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async searchSecrets(query: string): Promise<{ matches: string[]; total: number }> {
    return this.request('/secrets/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  async getOtp(name: string): Promise<{ otp: string }> {
    return this.request(`/secrets/${encodeURIComponent(name)}/otp`);
  }

  async syncStore(): Promise<{ success: boolean; message: string }> {
    return this.request('/secrets/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async auditPasswords(): Promise<AuditResponse> {
    return this.request('/secrets/audit');
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

export const api = new ApiService();
export default api;
