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
  | "GENERATE_PASSWORD"
  | "SCHEDULE_CLIPBOARD_CLEAR";

/**
 * Message the service worker sends to the offscreen document when a scheduled
 * clipboard-clear alarm fires. Kept distinct from `MessageType` (popup → SW)
 * because it flows SW → offscreen and carries only a hash of the secret.
 */
export const OFFSCREEN_CLEAR_CLIPBOARD = "OFFSCREEN_CLEAR_CLIPBOARD" as const;

export type CredentialMatch = {
  accountId: string;
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
  accountId: string;
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

/**
 * Popup → service worker: offload the clipboard auto-clear so it survives the
 * MV3 popup closing (which destroys the popup's `setTimeout`). Only the SHA-256
 * `hash` of the secret is sent — never the plaintext.
 */
export type ScheduleClipboardClearRequest = {
  type: "SCHEDULE_CLIPBOARD_CLEAR";
  hash: string;
  seconds?: number;
};

/** Service worker → offscreen document: clear the clipboard if it still holds the secret. */
export type OffscreenClearClipboardRequest = {
  type: typeof OFFSCREEN_CLEAR_CLIPBOARD;
  hash: string;
};

export type OffscreenClearClipboardResponse = {
  ok: boolean;
  cleared: boolean;
};

export type BackgroundRequest =
  | GetCredentialsRequest
  | FillCredentialRequest
  | SaveCredentialRequest
  | GeneratePasswordRequest
  | ScheduleClipboardClearRequest;

export type BackgroundResponse =
  | GetCredentialsResponse
  | GeneratePasswordResponse
  | { ok: boolean; error?: string };
