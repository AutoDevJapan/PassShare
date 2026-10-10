import { authFetch } from "./auth-api";
import type { ItemContext, OwnerContext } from "./cloud-worker";

export type BoxState = { mode: "compatibility"; keyEpoch: null } | { mode: "encrypted"; keyEpoch: number };
export type OwnerBundle = { format: number; salt: string; wrapped: { format: number; context: OwnerContext; nonce: string; ciphertext: string } };
export class CloudApiError extends Error {
  constructor(readonly status: number, readonly code?: string) { super("Encrypted storage request failed"); }
}
const path = (boxId: string) => `/api/encrypted/boxes/${encodeURIComponent(boxId)}`;
async function request(url: string, init?: RequestInit) {
  const response = await authFetch(url, { cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // Never reflect remote messages or input in errors.
    const remoteCode = body?.code ?? body?.error;
    const code = ["PS015", "PS055"].find((known) =>
      typeof remoteCode === "string" && (remoteCode === known || remoteCode.startsWith(`${known}:`)));
    throw new CloudApiError(response.status, code);
  }
  try {
    const reply = await response.json();
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new CloudApiError(502);
    return reply;
  } catch { throw new CloudApiError(502); }
}
export async function getBoxState(boxId: string, signal?: AbortSignal): Promise<BoxState> {
  const state = await request(path(boxId), { signal });
  if (state.mode === "compatibility" && state.keyEpoch === null) return state;
  if (state.mode === "encrypted" && Number.isSafeInteger(state.keyEpoch) && state.keyEpoch > 0) return state;
  throw new CloudApiError(502);
}
export async function getOwnerBundle(boxId: string, signal?: AbortSignal): Promise<{ bundleVersion: number; bundle: OwnerBundle }> {
  const reply = await request(`${path(boxId)}/owner-key`, { signal });
  if (!Number.isSafeInteger(reply.bundleVersion) || reply.bundleVersion < 1) throw new CloudApiError(502);
  bundleText(reply.bundle);
  return reply;
}
export async function setupBox(boxId: string, bundle: OwnerBundle, signal?: AbortSignal): Promise<void> {
  const reply = await request(`${path(boxId)}/setup`, { method: "POST", body: `{"bundle":${bundleText(bundle)}}`, signal });
  if (reply.mode !== "encrypted" || reply.keyEpoch !== 1 || reply.bundleVersion !== 1 ||
    !sameBundle(reply.bundle, bundle)) throw new CloudApiError(502);
}

// Exact public transport fields only. Rust validates policy, context and ciphertext.
function fields(value: unknown, keys: string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export function bundleText(bundle: OwnerBundle): string {
  if (!fields(bundle, ["format", "salt", "wrapped"]) ||
    !fields(bundle.wrapped, ["format", "context", "nonce", "ciphertext"]) ||
    !fields(bundle.wrapped.context, ["passwordBoxId", "ownerAccountId", "keyEpoch"])) throw new CloudApiError(502);
  const { format, salt, wrapped } = bundle;
  if (!Number.isSafeInteger(format) || !Number.isSafeInteger(wrapped.format) ||
    [salt, wrapped.nonce, wrapped.ciphertext].some((value) => typeof value !== "string") ||
    !Object.entries(wrapped.context).every(([name, value]) => name === "keyEpoch"
      ? Number.isSafeInteger(value) : typeof value === "string"))
    throw new CloudApiError(502);
  // Serialize the complete Rust-produced public envelope uniformly. Domain
  // context validation belongs to Rust; no secret or key field is projected.
  return JSON.stringify(bundle, (_name, value: unknown) => value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
}
export function sameBundle(left: OwnerBundle, right: OwnerBundle): boolean {
  try { return bundleText(left) === bundleText(right); } catch { return false; }
}
const pendingKey = (ownerId: string, boxId: string) => `passshare.cloud-setup.v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(boxId)}`;
export function readPendingBundle(ownerId: string, boxId: string): OwnerBundle | null {
  try {
    const text = localStorage.getItem(pendingKey(ownerId, boxId));
    if (text === null) return null;
    const bundle = JSON.parse(text) as OwnerBundle;
    bundleText(bundle);
    return bundle;
  } catch { throw new CloudApiError(409, "PS015"); }
}
export function savePendingBundle(ownerId: string, boxId: string, bundle: OwnerBundle) {
  const prior = readPendingBundle(ownerId, boxId);
  if (prior && !sameBundle(prior, bundle)) throw new CloudApiError(409, "PS015");
  const text = bundleText(bundle);
  try {
    localStorage.setItem(pendingKey(ownerId, boxId), text);
    if (localStorage.getItem(pendingKey(ownerId, boxId)) !== text) throw new CloudApiError(409, "PS015");
  } catch { throw new CloudApiError(409, "PS015"); }
}
export function clearPendingBundle(ownerId: string, boxId: string, expected: OwnerBundle) {
  const pending = readPendingBundle(ownerId, boxId);
  if (pending && !sameBundle(pending, expected)) throw new CloudApiError(409, "PS015");
  try { localStorage.removeItem(pendingKey(ownerId, boxId)); }
  catch { throw new CloudApiError(409, "PS015"); }
}

// Ciphertext-only session transport. These checks concern public routing fields;
// authentication of the envelope and validation of the whole DTO belong to Core.
export type EncryptedEnvelope = { format: 1; context: ItemContext; nonce: string; ciphertext: string };
export type EncryptedItemMetadata = { itemId: string; itemVersion: number; keyEpoch: number };
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{26}$/.test(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function validateItemContext(context: ItemContext): void {
  if (!fields(context, ["passwordBoxId", "itemId", "itemVersion", "keyEpoch"]) ||
    !validId(context.passwordBoxId) || !validId(context.itemId) ||
    !positiveInteger(context.itemVersion) || !positiveInteger(context.keyEpoch)) throw new CloudApiError(502);
}
function base64Size(value: unknown, min: number, max: number): boolean {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(max / 3) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try { const bytes = atob(value); return bytes.length >= min && bytes.length <= max && btoa(bytes) === value; }
  catch { return false; }
}
export function readItemEnvelope(text: string, expected?: ItemContext): EncryptedEnvelope {
  let envelope: EncryptedEnvelope;
  try {
    if (text.length > 1572864) throw new CloudApiError(502);
    envelope = JSON.parse(text) as EncryptedEnvelope;
  } catch { throw new CloudApiError(502); }
  if (!fields(envelope, ["format", "context", "nonce", "ciphertext"]) || envelope.format !== 1 ||
    !base64Size(envelope.nonce, 24, 24) || !base64Size(envelope.ciphertext, 16, 1048592)) throw new CloudApiError(502);
  validateItemContext(envelope.context);
  if (expected) {
    validateItemContext(expected);
    if (envelope.context.keyEpoch !== expected.keyEpoch) throw new CloudApiError(409, "PS056");
    if (envelope.context.passwordBoxId !== expected.passwordBoxId || envelope.context.itemId !== expected.itemId ||
      envelope.context.itemVersion !== expected.itemVersion || envelope.context.keyEpoch !== expected.keyEpoch) throw new CloudApiError(502);
  }
  return envelope;
}
async function boundedText(response: Response, limit: number): Promise<string> {
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new CloudApiError(502);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new CloudApiError(502);
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function itemRequest(url: string, init: RequestInit, status = 200): Promise<string> {
  try {
    const response = await authFetch(url, { cache: "no-store", redirect: "error", ...init });
    if (response.status !== status) {
      let code: string | undefined;
      try {
        const body = JSON.parse(await boundedText(response, 65536));
        const remote = body?.code ?? body?.error;
        code = ["PS015", "PS056"].find((known) => remote === known ||
          (typeof remote === "string" && remote.startsWith(`${known}:`)));
      } catch { /* Remote diagnostics never leave the transport. */ }
      throw new CloudApiError(response.status, code);
    }
    if (status === 204 && (response.headers.has("Transfer-Encoding") ||
      (response.headers.has("Content-Length") && response.headers.get("Content-Length") !== "0"))) throw new CloudApiError(502);
    return await boundedText(response, status === 204 ? 0 : 1572864);
  } catch (error) {
    if (error instanceof CloudApiError) throw error;
    throw new CloudApiError(0);
  }
}
function itemsPath(boxId: string, itemId?: string): string {
  if (!validId(boxId) || (itemId !== undefined && !validId(itemId))) throw new CloudApiError(502);
  return `${path(boxId)}/items${itemId === undefined ? "" : `/${itemId}`}`;
}
export async function listEncryptedItems(boxId: string, keyEpoch: number, after: string | null, signal: AbortSignal):
Promise<{ items: EncryptedItemMetadata[]; nextCursor: string | null }> {
  if (!positiveInteger(keyEpoch) || (after !== null && !validId(after))) throw new CloudApiError(502);
  const text = await itemRequest(`${itemsPath(boxId)}${after === null ? "" : `?after=${after}`}`, { signal });
  let page: { items: EncryptedItemMetadata[]; nextCursor: string | null };
  try { page = JSON.parse(text); } catch { throw new CloudApiError(502); }
  if (!fields(page, ["items", "nextCursor"]) || !Array.isArray(page.items) || page.items.length > 100) throw new CloudApiError(502);
  let previous = after ?? "";
  for (const entry of page.items) {
    if (!fields(entry, ["itemId", "itemVersion", "keyEpoch"]) || !validId(entry.itemId) || entry.itemId <= previous ||
      !positiveInteger(entry.itemVersion) || !positiveInteger(entry.keyEpoch)) throw new CloudApiError(502);
    if (entry.keyEpoch !== keyEpoch) throw new CloudApiError(409, "PS056");
    previous = entry.itemId;
  }
  if (page.items.length === 100 ? page.nextCursor !== previous : page.nextCursor !== null) throw new CloudApiError(502);
  return page;
}
export async function getEncryptedItem(expected: ItemContext, signal: AbortSignal): Promise<string> {
  validateItemContext(expected);
  const text = await itemRequest(itemsPath(expected.passwordBoxId, expected.itemId), { signal });
  readItemEnvelope(text, expected);
  return text;
}
export async function putEncryptedItem(expected: ItemContext, expectedVersion: number, envelopeJSON: string, signal: AbortSignal): Promise<string> {
  validateItemContext(expected);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER ||
    expected.itemVersion !== expectedVersion + 1) throw new CloudApiError(502);
  const sent = readItemEnvelope(envelopeJSON, expected);
  // Embed the exact prepared worker output, including on explicit retry.
  const text = await itemRequest(itemsPath(expected.passwordBoxId, expected.itemId), {
    method: "PUT", body: `{"expectedVersion":${expectedVersion},"envelope":${envelopeJSON}}`, signal,
  });
  const stored = readItemEnvelope(text, expected);
  if (stored.format !== sent.format || stored.nonce !== sent.nonce || stored.ciphertext !== sent.ciphertext) throw new CloudApiError(502);
  return text;
}
export async function deleteEncryptedItem(expected: ItemContext, signal: AbortSignal): Promise<void> {
  validateItemContext(expected);
  await itemRequest(itemsPath(expected.passwordBoxId, expected.itemId), { method: "DELETE",
    body: JSON.stringify({ expectedVersion: expected.itemVersion, keyEpoch: expected.keyEpoch }), signal }, 204);
}
