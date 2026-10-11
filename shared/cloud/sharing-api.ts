import type { CloudFetch } from "./session-transport";
import { CloudApiError } from "./cloud-api";
import type { PublicIdentity, SharedContext } from "./cloud-worker";
export type IdentityRecord = { bundleVersion: number; identity: PublicIdentity; bundle: unknown };
export type Member = { accountId: string; role: string; membershipConfirmed: boolean; keyGranted: boolean };
export type Snapshot = { stateRevision: number; keyEpoch: number; ownerAccountId: string; ownerBundleVersion: number;
  memberCount: number; liveItemCount: number; grantCount: number; liveAttachmentCount: number; liveAttachmentBytes: number };

export function createSharingApi(authFetch: CloudFetch) {
  // Public routing, ciphertext and independently held public pins only.
  // Cryptography, fingerprint comparison and membership policy run in Rust.

  const boxPath = (id: string) => `/api/encrypted/boxes/${encodeURIComponent(id)}`;
  const identityPath = "/api/encrypted/account-identity";
  const exact = (value: unknown, keys: string[]): boolean => !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;
  function publicText(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
  }
  async function request(url: string, signal: AbortSignal, body?: unknown): Promise<any> {
    const response = await authFetch(url, { signal, cache: "no-store", redirect: "error",
      ...(body === undefined ? {} : { method: "PUT", body: JSON.stringify(body) }) });
    if (response.status !== 200) throw new CloudApiError(response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new CloudApiError(502);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw new CloudApiError(502);
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(text); } catch { throw new CloudApiError(502); }
  }
  function record(value: IdentityRecord): IdentityRecord {
    if (!exact(value, ["bundleVersion", "identity", "bundle"]) || !positive(value.bundleVersion) ||
      !exact(value.identity, ["accountId", "identityVersion", "publicKey", "keyId"]) ||
      !positive(value.identity.identityVersion) || [value.identity.accountId, value.identity.publicKey, value.identity.keyId]
        .some((entry) => typeof entry !== "string") || publicText(value.bundle).length > 2048) throw new CloudApiError(502);
    return value;
  }
  async function getIdentity(signal: AbortSignal): Promise<IdentityRecord | null> {
    try { return record(await request(identityPath, signal)); }
    catch (error) { if (error instanceof CloudApiError && error.status === 404) return null; throw error; }
  }
  async function createIdentity(prepared: IdentityRecord, signal: AbortSignal): Promise<IdentityRecord> {
    record(prepared);
    const reply = record(await request(identityPath, signal, { expectedVersion: 0, identity: prepared.identity, bundle: prepared.bundle }));
    if (reply.bundleVersion !== 1 || publicText(reply) !== publicText(prepared)) throw new CloudApiError(409);
    return reply;
  }
  async function getMemberIdentity(boxId: string, accountId: string, signal: AbortSignal): Promise<PublicIdentity> {
    const reply = await request(`${boxPath(boxId)}/member-identities/${encodeURIComponent(accountId)}`, signal);
    if (!exact(reply, ["identity"])) throw new CloudApiError(502);
    const value = reply.identity;
    if (!exact(value, ["accountId", "identityVersion", "publicKey", "keyId"]) || value.accountId !== accountId ||
      !positive(value.identityVersion) || typeof value.publicKey !== "string" || typeof value.keyId !== "string") throw new CloudApiError(502);
    return value;
  }
  async function getSnapshot(boxId: string, signal: AbortSignal): Promise<Snapshot> {
    const value = await request(`${boxPath(boxId)}/sharing-snapshot`, signal);
    const keys = ["stateRevision", "keyEpoch", "ownerAccountId", "ownerBundleVersion", "memberCount", "liveItemCount", "grantCount"];
    // The official API omits both attachment counters only for an empty set.
    // Keep strict shape validation, including rejection of a missing peer counter.
    const hasAttachments = !!value && Object.hasOwn(value, "liveAttachmentCount");
    if (!exact(value, hasAttachments ? [...keys, "liveAttachmentCount", "liveAttachmentBytes"] : keys) ||
      ![value.stateRevision, value.keyEpoch, value.ownerBundleVersion, value.memberCount].every(positive) ||
      ![value.liveItemCount, value.grantCount].every((v) => Number.isSafeInteger(v) && v >= 0) || typeof value.ownerAccountId !== "string" ||
      (hasAttachments && (!positive(value.liveAttachmentCount) || value.liveAttachmentCount > 1024 ||
        !positive(value.liveAttachmentBytes) || value.liveAttachmentBytes > 1073741824))) throw new CloudApiError(502);
    return { ...value, liveAttachmentCount: value.liveAttachmentCount ?? 0, liveAttachmentBytes: value.liveAttachmentBytes ?? 0 };
  }
  async function getSnapshotMembers(boxId: string, snapshot: Snapshot, signal: AbortSignal): Promise<Member[]> {
    const members: Member[] = [];
    let after: string | null = null;
    do {
      const page = await request(`${boxPath(boxId)}/sharing-snapshot/members?revision=${snapshot.stateRevision}${after === null ? "" : `&after=${encodeURIComponent(after)}`}`, signal);
      if (!exact(page, ["stateRevision", "members", "nextCursor"]) || page.stateRevision !== snapshot.stateRevision ||
        !Array.isArray(page.members) || page.members.length > 100) throw new CloudApiError(502);
      let previous = after ?? "";
      for (const member of page.members) {
        if (!exact(member, ["accountId", "role", "membershipConfirmed", "keyGranted"]) ||
          typeof member.accountId !== "string" || member.accountId <= previous || typeof member.role !== "string" ||
          typeof member.membershipConfirmed !== "boolean" || typeof member.keyGranted !== "boolean") throw new CloudApiError(502);
        previous = member.accountId;
        members.push(member);
      }
      if ((page.members.length === 100 ? page.nextCursor !== previous : page.nextCursor !== null) ||
        members.length > snapshot.memberCount || members.length > 1000) throw new CloudApiError(502);
      after = page.nextCursor;
    } while (after !== null);
    if (members.length !== snapshot.memberCount) throw new CloudApiError(502);
    return members;
  }
  async function putGrant(boxId: string, revision: number, context: SharedContext, envelope: unknown, signal: AbortSignal): Promise<void> {
    const reply = await request(`${boxPath(boxId)}/grants/${encodeURIComponent(context.recipientAccountId)}`, signal,
      { expectedStateRevision: revision, keyEpoch: context.keyEpoch, expectedVersion: 0, envelope });
    if (!exact(reply, ["grantVersion", "keyEpoch", "stateRevision", "envelope"]) || reply.grantVersion !== 1 ||
      reply.keyEpoch !== context.keyEpoch || !positive(reply.stateRevision) || reply.stateRevision < revision ||
      publicText(reply.envelope) !== publicText(envelope)) throw new CloudApiError(502);
  }
  async function getSelfGrant(boxId: string, context: SharedContext, signal: AbortSignal): Promise<string> {
    const reply = await request(`${boxPath(boxId)}/grants/me`, signal);
    if (!exact(reply, ["grantVersion", "keyEpoch", "envelope"]) || reply.grantVersion !== 1 || reply.keyEpoch !== context.keyEpoch ||
      !exact(reply.envelope, ["format", "suite", "context", "enc", "ciphertext"]) ||
      publicText(reply.envelope.context) !== publicText(context) || publicText(reply.envelope).length > 2048) throw new CloudApiError(502);
    return JSON.stringify(reply.envelope);
  }

  // Three separate, account-scoped stores. Neither bundle nor a server reply
  // supplies an expected context/key ID. Pins contain public descriptors only.
  const ownKey = (account: string) => `passshare.identity-own-pin.v1:${encodeURIComponent(account)}`;
  const peerKey = (account: string, peer: string) => `passshare.identity-peer-pin.v1:${encodeURIComponent(account)}:${encodeURIComponent(peer)}`;
  const pendingKey = (account: string) => `passshare.identity-pending.v1:${encodeURIComponent(account)}`;
  function read(key: string): unknown | null {
    try { const text = localStorage.getItem(key); return text === null ? null : JSON.parse(text); }
    catch { throw new CloudApiError(409); }
  }
  function write(key: string, value: unknown) {
    const text = publicText(value);
    try { localStorage.setItem(key, text); if (localStorage.getItem(key) !== text) throw new CloudApiError(409); }
    catch { throw new CloudApiError(409); }
  }
  function readOwnPin(account: string): PublicIdentity | null { return read(ownKey(account)) as PublicIdentity | null; }
  // Call only with the pin returned by Rust identityPrepare after private-key
  // restoration and an independently entered code (or the existing own pin).
  function savePreparedOwnPin(account: string, identity: PublicIdentity) {
    if (identity.accountId !== account) throw new CloudApiError(409);
    write(ownKey(account), identity);
  }
  function readPeerPin(account: string, peer: string): PublicIdentity | null { return read(peerKey(account, peer)) as PublicIdentity | null; }
  function savePeerPin(account: string, peer: string, identity: PublicIdentity) {
    if (identity.accountId !== peer) throw new CloudApiError(409);
    write(peerKey(account, peer), identity);
  }
  function readPendingIdentity(account: string): IdentityRecord | null {
    const value = read(pendingKey(account)); return value === null ? null : record(value as IdentityRecord);
  }
  function savePendingIdentity(account: string, value: IdentityRecord) {
    const previous = readPendingIdentity(account);
    if (value.identity.accountId !== account || (previous && publicText(previous) !== publicText(value))) throw new CloudApiError(409);
    write(pendingKey(account), record(value));
  }
  function clearPendingIdentity(account: string, expected: IdentityRecord) {
    const value = readPendingIdentity(account);
    if (value && publicText(value) !== publicText(expected)) throw new CloudApiError(409);
    localStorage.removeItem(pendingKey(account));
  }

  return Object.freeze({ publicText, getIdentity, createIdentity, getMemberIdentity, getSnapshot, getSnapshotMembers, putGrant, getSelfGrant, readOwnPin, savePreparedOwnPin, readPeerPin, savePeerPin, readPendingIdentity, savePendingIdentity, clearPendingIdentity });
}
export type SharingApi = ReturnType<typeof createSharingApi>;
