import {
  CONNECT_API_VERSION,
  CONNECT_ITEM_CATEGORIES,
  CONNECT_OPENAPI_PATHS,
  CONNECT_OPERATION_IDS,
  PASSSHARE_EXTENSION_PATHS,
} from "./generated/connect-api.js";

export type {
  ConnectErrorResponse,
  ConnectOpenApiPath,
  ConnectOperationId,
  FileMeta,
  Item,
  ItemCategory,
  ItemOverview,
  Vault,
} from "./generated/connect-api.js";

export {
  CONNECT_API_VERSION,
  CONNECT_ITEM_CATEGORIES,
  CONNECT_OPENAPI_PATHS,
  CONNECT_OPERATION_IDS,
  PASSSHARE_EXTENSION_PATHS,
};

export type ConnectClientOptions = {
  host: string;
  token: string;
};

export type JsonPatchOperation = {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
};

/** Alias for SDK consumers. */
export const ITEM_CATEGORIES = CONNECT_ITEM_CATEGORIES;
