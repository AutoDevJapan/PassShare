/**
 * Generate minimal Connect API TypeScript types from OpenAPI SSOT.
 * Issue #55 — drift check via CI compares output to committed file.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const openapiPath = join(root, "documents/spec/openapi/connect-api.yaml");
const outputPath = join(root, "packages/connect-js/src/generated/connect-api.ts");

const spec = yaml.parse(readFileSync(openapiPath, "utf8"));
const paths = Object.keys(spec.paths ?? {}).sort();
const operations = [];

for (const pathKey of paths) {
  const methods = spec.paths[pathKey];
  for (const method of Object.keys(methods)) {
    if (method === "parameters") continue;
    const op = methods[method];
    if (op?.operationId) {
      operations.push(op.operationId);
    }
  }
}

const passsharePaths = [
  "/health",
  "/health/db",
  "/metrics",
  "/vaults/{vaultUuid}/imports/1pux",
];

const header = `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: documents/spec/openapi/connect-api.yaml
 * Run: pnpm --dir backend generate:types
 */
`;

const body = `${header}
export const CONNECT_API_VERSION = ${JSON.stringify(spec.info?.version ?? "1.0.0")};

export const CONNECT_OPENAPI_PATHS = ${JSON.stringify(paths, null, 2)} as const;

export const CONNECT_OPERATION_IDS = ${JSON.stringify(operations.sort(), null, 2)} as const;

export const PASSSHARE_EXTENSION_PATHS = ${JSON.stringify(passsharePaths, null, 2)} as const;

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
  favorite?: boolean;
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
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, body, "utf8");
console.log(`Wrote ${outputPath}`);
