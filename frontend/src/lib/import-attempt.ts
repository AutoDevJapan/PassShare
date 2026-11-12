export type ImportAttempt = { scope: string; fingerprint: string; keys: string[]; completed: Set<number> };
const attempts = new Map<string, ImportAttempt>();
const active = new WeakSet<ImportAttempt>();
const finished = new WeakSet<ImportAttempt>();
export function acquireImportAttempt(attempt: ImportAttempt): void {
  if(active.has(attempt)||finished.has(attempt))throw new Error('Import attempt is active or completed');
  active.add(attempt);
}
export function releaseImportAttempt(attempt: ImportAttempt): void { active.delete(attempt); }
const storageKey = (scope: string, fingerprint: string) => `passshare-csv-retry-v1:${scope}:${fingerprint}`;
// Accidental-corruption detection only, not authentication against same-origin code.
function checkpointChecksum(scope:string,fingerprint:string,keys:string[],completed:number[]):string{
  let hash=2166136261;
  for(const byte of new TextEncoder().encode(JSON.stringify([scope,fingerprint,keys,completed])))hash=Math.imul(hash^byte,16777619)>>>0;
  return hash.toString(16).padStart(8,'0');
}

export function saveImportAttempt(attempt: ImportAttempt): void {
  if(finished.has(attempt))throw new Error('Import attempt already completed');
  const completed=[...attempt.completed].sort((a,b)=>a-b);
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(storageKey(attempt.scope, attempt.fingerprint), JSON.stringify({keys:attempt.keys, completed,checksum:checkpointChecksum(attempt.scope,attempt.fingerprint,attempt.keys,completed)}));
  attempts.set(storageKey(attempt.scope, attempt.fingerprint), attempt);
}

export function finishImportAttempt(attempt: ImportAttempt): void {
  if(finished.has(attempt))throw new Error('Import attempt already completed');
  const key=storageKey(attempt.scope,attempt.fingerprint);
  if(attempts.get(key)!==attempt)throw new Error('Import attempt was replaced');
  if(typeof sessionStorage!=='undefined')sessionStorage.removeItem(key);
  attempts.delete(key);
  finished.add(attempt);
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
      if(!Array.isArray(saved.keys)||saved.keys.length!==rows||new Set(saved.keys).size!==rows||saved.keys.some((k:unknown)=>typeof k!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(k))||!Array.isArray(saved.completed)||saved.completed.some((i:unknown)=>!Number.isInteger(i)||Number(i)<0||Number(i)>=rows))throw new Error('Invalid saved import retry');
      if(saved.checksum!==checkpointChecksum(scope,fingerprint,saved.keys,saved.completed))throw new Error('Import retry checksum mismatch');
      const restored={scope,fingerprint,keys:saved.keys as string[],completed:new Set<number>(saved.completed)};
      attempts.set(key,restored);return restored;
    }
  }
  const created={ scope, fingerprint, keys: Array.from({ length: rows }, () => crypto.randomUUID()), completed: new Set<number>() };
  saveImportAttempt(created);return created;
}
