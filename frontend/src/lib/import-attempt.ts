export type ImportAttempt = { scope: string; fingerprint: string; keys: string[]; completed: Set<number> };

// Identify a retry of one import, not duplicate content across independent items.
export async function importFingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  try {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { bytes.fill(0); }
}

export function importAttempt(prior: ImportAttempt | null, scope: string, fingerprint: string, rows: number): ImportAttempt {
  if (prior?.scope === scope && prior.fingerprint === fingerprint && prior.keys.length === rows) return prior;
  return { scope, fingerprint, keys: Array.from({ length: rows }, () => crypto.randomUUID()), completed: new Set() };
}
