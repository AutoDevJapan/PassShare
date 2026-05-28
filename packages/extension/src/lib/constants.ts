export const EXTENSION_CLIENT_HEADER = "x-passshare-client";
export const EXTENSION_CLIENT_VALUE = "extension";

export const STORAGE_KEYS = {
  refreshToken: "passshare.refreshToken",
  connectToken: "passshare.connectToken",
  connectExpiresAt: "passshare.connectExpiresAt",
  locale: "passshare.locale",
} as const;

export type MessageType =
  | "GET_CREDENTIALS_FOR_HOST"
  | "FILL_CREDENTIAL"
  | "SAVE_CREDENTIAL"
  | "GENERATE_PASSWORD";

export type CredentialMatch = {
  itemId: string;
  vaultId: string;
  title: string;
  username: string;
  password: string;
  url: string | null;
};

export type GetCredentialsRequest = {
  type: "GET_CREDENTIALS_FOR_HOST";
  hostname: string;
};

export type GetCredentialsResponse = {
  ok: boolean;
  matches: CredentialMatch[];
  error?: string;
};

export type FillCredentialRequest = {
  type: "FILL_CREDENTIAL";
  itemId: string;
  vaultId: string;
};

export type SaveCredentialRequest = {
  type: "SAVE_CREDENTIAL";
  title: string;
  username: string;
  password: string;
  url: string;
};

export type GeneratePasswordRequest = {
  type: "GENERATE_PASSWORD";
  length?: number;
};

export type GeneratePasswordResponse = {
  ok: boolean;
  password?: string;
  error?: string;
};

export type BackgroundRequest =
  | GetCredentialsRequest
  | FillCredentialRequest
  | SaveCredentialRequest
  | GeneratePasswordRequest;

export type BackgroundResponse =
  | GetCredentialsResponse
  | GeneratePasswordResponse
  | { ok: boolean; error?: string };
