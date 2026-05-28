/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: documents/spec/openapi/connect-api.yaml
 * Run: pnpm --dir backend generate:types
 */

export const CONNECT_API_VERSION = "1.0.0";

export const CONNECT_OPENAPI_PATHS = [
  "/vaults",
  "/vaults/{vaultUuid}",
  "/vaults/{vaultUuid}/imports/1pux",
  "/vaults/{vaultUuid}/items",
  "/vaults/{vaultUuid}/items/{itemUuid}",
  "/vaults/{vaultUuid}/items/{itemUuid}/files/{fileUuid}",
  "/vaults/{vaultUuid}/items/{itemUuid}/files/{fileUuid}/content"
] as const;

export const CONNECT_OPERATION_IDS = [
  "createFile",
  "createItem",
  "deleteFile",
  "deleteItem",
  "getFile",
  "getFileContent",
  "getItem",
  "getVault",
  "import1pux",
  "listItems",
  "listVaults",
  "patchItem",
  "replaceItem"
] as const;

export const PASSSHARE_EXTENSION_PATHS = [
  "/health",
  "/health/db",
  "/metrics",
  "/vaults/{vaultUuid}/imports/1pux"
] as const;

export const CONNECT_ITEM_CATEGORIES = [
  "LOGIN",
  "PASSWORD",
  "SECURE_NOTE",
  "CREDIT_CARD",
  "IDENTITY",
  "SSH_KEY",
  "CUSTOM",
] as const;

export type ConnectOperationId = (typeof CONNECT_OPERATION_IDS)[number];

export type ConnectOpenApiPath = (typeof CONNECT_OPENAPI_PATHS)[number];

export type ItemCategory = (typeof CONNECT_ITEM_CATEGORIES)[number];

export type Vault = {
  id: string;
  name: string;
  description?: string;
  type: string;
  items: number;
  createdAt: string;
  updatedAt: string;
  contentVersion?: number;
  attributeVersion?: number;
};

export type ItemOverview = {
  id: string;
  title: string;
  version: number;
  vault: { id: string };
  category: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
};

export type Item = ItemOverview & {
  fields?: Array<{
    id?: string;
    label: string;
    type: string;
    purpose?: string;
    value: string;
  }>;
  urls?: Array<{ href: string; primary?: boolean; label?: string }>;
};

export type ConnectErrorResponse = {
  status: number;
  message: string;
};

export type FileMeta = {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  updatedAt: string;
};
