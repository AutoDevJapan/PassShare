import crypto from "node:crypto";

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LEN = 26;

/** @param {string} id */
export function isValidConnectId(id) {
  return typeof id === "string" && id.length === ID_LEN && /^[a-z0-9]+$/.test(id);
}

export function generateConnectId() {
  const bytes = crypto.randomBytes(ID_LEN);
  return Array.from(bytes, (b) => CHARSET[b % CHARSET.length]).join("");
}

export function nowIso() {
  return new Date().toISOString();
}

/** @param {unknown} item */
export function toItemOverview(item) {
  return {
    id: item.id,
    title: item.title,
    version: item.version ?? 1,
    vault: item.vault,
    category: item.category,
    lastEditedBy: item.lastEditedBy ?? undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    additionalInformation: item.additionalInformation ?? undefined,
    tags: item.tags ?? [],
    urls: item.urls ?? [],
      favorite: Boolean(item.favorite),
      username: item.fields?.find(field=>field.purpose?.toUpperCase()==='USERNAME')?.value ?? '',
      hasPassword: Boolean(item.fields?.some(field=>field.purpose?.toUpperCase()==='PASSWORD'&&field.value)),
      hasBody: Boolean(item.fields?.some(field=>['notes','body'].includes(field.label?.toLowerCase())&&field.value)),
      bodyPreview: (item.fields?.find(field=>field.label?.toLowerCase()==='notes')?.value ?? item.fields?.find(field=>field.label?.toLowerCase()==='body')?.value ?? '').slice(0,80),
  };
}

/** @param {Record<string, unknown>} vaultRow */
export function rowToVault(vaultRow, itemCount = 0) {
  return {
    id: vaultRow.id,
    name: vaultRow.name,
    description: vaultRow.description ?? "",
    type: vaultRow.type ?? "USER_CREATED",
    items: itemCount,
    createdAt: vaultRow.created_at ?? vaultRow.createdAt,
    updatedAt: vaultRow.updated_at ?? vaultRow.updatedAt,
    contentVersion: vaultRow.content_version ?? vaultRow.contentVersion ?? 1,
    attributeVersion: vaultRow.attribute_version ?? vaultRow.attributeVersion ?? 1,
  };
}
