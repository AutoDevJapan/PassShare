import { createCloudApi, CloudApiError } from "./cloud-api";
import { createSharingApi } from "./sharing-api";

export type CloudFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type VaultMember = { userId: string; email: string; role: "owner" | "member"; joinedAt: string; identityConfirmed?: boolean };

// One immutable account/transport binding per authenticated renderer lifetime.
// Only the existing formal session token enters this closure, never a Connect token.
export function createCloudSession(base: string, userId: string, sessionToken: string, isCurrent: () => boolean = () => true) {
  const origin = new URL(base);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) throw new CloudApiError(0);
  let alive = true;
  const requests = new Set<AbortController>();
  const current = () => alive && isCurrent();
  const transport: CloudFetch = async (path, init = {}) => {
    if (!current()) throw new CloudApiError(401);
    const url = new URL(path, origin);
    if (!path.startsWith("/api/") || url.origin !== origin.origin) throw new CloudApiError(0);
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.throwIfAborted();
    init.signal?.addEventListener("abort", abort, { once: true });
    requests.add(controller);
    let bodyOwned = false;
    const cleanup = () => { requests.delete(controller); init.signal?.removeEventListener("abort", abort); };
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${sessionToken}`);
      if (init.body !== undefined && init.body !== null) headers.set("Content-Type", "application/json");
      const response = await fetch(url, { ...init, headers, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error" });
      if (!current() || controller.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        throw new CloudApiError(401);
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      const cancelBody = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancelBody, { once: true });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true; cleanup(); controller.signal.removeEventListener("abort", cancelBody); reader.releaseLock();
      };
      // Keep the account lifetime and caller abort bound through body EOF,
      // not merely until fetch has returned headers.
      const body = new ReadableStream<Uint8Array>({
        async pull(destination) {
          try {
            if (!current() || controller.signal.aborted) throw new CloudApiError(401);
            const part = await reader.read();
            if (!current() || controller.signal.aborted) { part.value?.fill(0); throw new CloudApiError(401); }
            if (part.done) { destination.close(); finish(); }
            else destination.enqueue(part.value);
          } catch (error) {
            await reader.cancel().catch(() => {});
            destination.error(error instanceof CloudApiError ? error : new CloudApiError(0)); finish();
          }
        },
        async cancel() { try { await reader.cancel(); } finally { finish(); } },
      });
      try {
        const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        bodyOwned = true;
        return result;
      } catch { await body.cancel().catch(() => {}); finish(); throw new CloudApiError(0); }
    } finally {
      if (!bodyOwned) cleanup();
    }
  };
  return Object.freeze({
    userId, api: createCloudApi(transport), sharing: createSharingApi(transport), transport,
    async listVaultMembers(boxId: string, signal: AbortSignal): Promise<VaultMember[]> {
      const response = await transport(`/api/auth/vaults/${encodeURIComponent(boxId)}/members`, { signal });
      if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new CloudApiError(response.status); }
      const body = await response.json() as { members: VaultMember[] };
      if (!Array.isArray(body.members)) throw new CloudApiError(502);
      return body.members;
    },
    dispose() { alive = false; sessionToken = ""; for (const request of requests) request.abort(); requests.clear(); },
  });
}
export type CloudSession = ReturnType<typeof createCloudSession>;
