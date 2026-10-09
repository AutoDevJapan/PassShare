import { authFetch } from "./auth-api";
import type { OwnerContext } from "./cloud-worker";

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
  const { passwordBoxId, ownerAccountId, keyEpoch } = wrapped.context;
  if (!Number.isSafeInteger(format) || !Number.isSafeInteger(wrapped.format) || !Number.isSafeInteger(keyEpoch) ||
    [salt, passwordBoxId, ownerAccountId, wrapped.nonce, wrapped.ciphertext].some((value) => typeof value !== "string"))
    throw new CloudApiError(502);
  return JSON.stringify({ format, salt, wrapped: { format: wrapped.format,
    context: { passwordBoxId, ownerAccountId, keyEpoch }, nonce: wrapped.nonce, ciphertext: wrapped.ciphertext } });
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
