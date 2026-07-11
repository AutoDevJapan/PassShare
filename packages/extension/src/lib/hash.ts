/**
 * SHA-256 hex digest of a UTF-8 string.
 *
 * Used to fingerprint a copied secret so the service worker can schedule a
 * clipboard clear without ever persisting the plaintext: the popup hashes the
 * value, the offscreen document hashes the current clipboard contents, and the
 * two are compared. `crypto.subtle` is available in the popup, the service
 * worker, and offscreen documents alike.
 */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
