export type ImportAttempt = { scope: string; fingerprint: string; keys: string[]; completed: Set<number> };
const attempts = new Map<string, ImportAttempt>();
const storageKey = (scope: string, fingerprint: string) => `passshare-csv-retry-v1:${scope}:${fingerprint}`;

export function saveImportAttempt(attempt: ImportAttempt): void {
  attempts.set(storageKey(attempt.scope, attempt.fingerprint), attempt);
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(storageKey(attempt.scope, attempt.fingerprint), JSON.stringify({keys:attempt.keys, completed:[...attempt.completed]}));
}

export function finishImportAttempt(attempt: ImportAttempt): void {
  const key=storageKey(attempt.scope,attempt.fingerprint);
  attempts.delete(key);
  if(typeof sessionStorage!=='undefined')sessionStorage.removeItem(key);
}

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
  const key=storageKey(scope,fingerprint);
  const existing=attempts.get(key);
  if(existing&&existing.keys.length===rows)return existing;
  if(typeof sessionStorage!=='undefined'){
    const raw=sessionStorage.getItem(key);
    if(raw){
      const saved=JSON.parse(raw);
      if(!Array.isArray(saved.keys)||saved.keys.length!==rows||saved.keys.some((k:unknown)=>typeof k!=='string'||!/^[0-9a-f-]{36}$/.test(k))||!Array.isArray(saved.completed)||saved.completed.some((i:unknown)=>!Number.isInteger(i)||Number(i)<0||Number(i)>=rows))throw new Error('Invalid saved import retry');
      const restored={scope,fingerprint,keys:saved.keys as string[],completed:new Set<number>(saved.completed)};
      attempts.set(key,restored);return restored;
    }
  }
  const created={ scope, fingerprint, keys: Array.from({ length: rows }, () => crypto.randomUUID()), completed: new Set<number>() };
  saveImportAttempt(created);return created;
}
