import type { ConnectClientOptions, Item, ItemOverview, JsonPatchOperation, Vault } from "./types.js";

function normalizeBaseUrl(host: string): string {
  const trimmed = host.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export class ConnectClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: ConnectClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.host);
    this.token = options.token;
  }

  static fromEnv(): ConnectClient {
    const host = process.env.OP_CONNECT_HOST;
    const token = process.env.OP_CONNECT_TOKEN;
    if (!host) throw new Error("Missing OP_CONNECT_HOST");
    if (!token) throw new Error("Missing OP_CONNECT_TOKEN");
    return new ConnectClient({ host, token });
  }

  async listVaults(): Promise<Vault[]> {
    return this.request<Vault[]>("/vaults");
  }

  async getVault(vaultId: string): Promise<Vault> {
    return this.request<Vault>(`/vaults/${vaultId}`);
  }

  async listItems(vaultId: string): Promise<ItemOverview[]> {
    return this.request<ItemOverview[]>(`/vaults/${vaultId}/items`);
  }

  async getItem(vaultId: string, itemId: string): Promise<Item> {
    return this.request<Item>(`/vaults/${vaultId}/items/${itemId}`);
  }

  async createItem(vaultId: string, item: Record<string, unknown>): Promise<Item> {
    return this.request<Item>(`/vaults/${vaultId}/items`, {
      method: "POST",
      body: JSON.stringify(item),
    });
  }

  async replaceItem(vaultId: string, itemId: string, item: Record<string, unknown>): Promise<Item> {
    return this.request<Item>(`/vaults/${vaultId}/items/${itemId}`, {
      method: "PUT",
      body: JSON.stringify(item),
    });
  }

  async patchItem(vaultId: string, itemId: string, patch: JsonPatchOperation[]): Promise<Item> {
    return this.request<Item>(`/vaults/${vaultId}/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(patch),
    });
  }

  async deleteItem(vaultId: string, itemId: string): Promise<void> {
    await this.request<void>(`/vaults/${vaultId}/items/${itemId}`, { method: "DELETE" });
  }

  async import1pux(vaultId: string, base64Payload: string): Promise<{ imported: number }> {
    return this.request<{ imported: number }>(`/vaults/${vaultId}/imports/1pux`, {
      method: "POST",
      body: JSON.stringify({ base64: base64Payload }),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) {
      throw Object.assign(new Error(body.message ?? `Connect API error ${response.status}`), { status: response.status });
    }
    return body as T;
  }
}

export * from "./types.js";
