import { CloudApiError, type BoxState, type CloudApi } from "./cloud-api";

export type CompatibilityProof = (boxId: string, signal: AbortSignal) => Promise<void>;

// The existing Web gate's flag-off path: 404 alone is never compatibility.
// The formal Connect metadata route preserves the DB ciphertext boundary even
// with the feature disabled, and returns 409 for an encrypted password box.
export async function readBoxMode(api: CloudApi, boxId: string, signal: AbortSignal,
  metadataProof?: CompatibilityProof, encryptedObserved = false): Promise<BoxState> {
  try { return await api.getBoxState(boxId, signal); }
  catch (error) {
    if (!(error instanceof CloudApiError) || error.status !== 404 || !metadataProof || encryptedObserved) throw error;
    signal.throwIfAborted();
    await metadataProof(boxId, signal);
    signal.throwIfAborted();
    return { mode: "compatibility", keyEpoch: null };
  }
}
