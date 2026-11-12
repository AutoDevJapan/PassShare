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
  const fields=Array.isArray(item.fields)?item.fields.filter(field=>field&&typeof field==='object'):[];
  const value=(key,name)=>fields.find(field=>typeof field[key]==='string'&&field[key].toLowerCase()===name&&typeof field.value==='string'&&!(typeof field.type==='string'&&field.type.toUpperCase()==='CONCEALED')&&!(typeof field.purpose==='string'&&field.purpose.toUpperCase()==='PASSWORD'))?.value??'';
  const password=fields.some(field=>typeof field.purpose==='string'&&field.purpose.toUpperCase()==='PASSWORD'&&typeof field.value==='string'&&field.value.length>0);
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
      username: value('purpose','username'),
      hasPassword: password,
      hasBody: Boolean(value('label','notes')||value('label','body')),
      bodyPreview: (value('label','notes')||value('label','body')).slice(0,81),
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
