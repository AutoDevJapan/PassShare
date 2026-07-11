/**
 * Minimal time-to-live cache used by the service worker to avoid re-decrypting
 * every credential on each password-field focus event.
 *
 * The cache is keyed by page hostname. Entries expire after `ttlMs` and the
 * whole cache can be invalidated (e.g. after a credential is saved) so stale
 * matches are never surfaced.
 */
export type TtlCacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlCache<T> {
  private readonly store = new Map<string, TtlCacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Opportunistically drop entries that expired since the last write so the
    // map does not accumulate hosts that are never focused again.
    this.pruneExpired();
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  private pruneExpired(): void {
    const nowMs = this.now();
    for (const [key, entry] of this.store) {
      if (nowMs >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
