import { TtlCache } from "./ttl-cache";

export type CachedLookup<T> = ((key: string) => Promise<T>) & {
  /** Drop every cached entry (e.g. after a mutation or auth change). */
  invalidate: () => void;
};

/**
 * Wraps an async keyed fetcher with a TTL cache and single-flight
 * de-duplication:
 *
 * - Cache hits skip the fetcher entirely.
 * - Concurrent lookups for the same key share one in-flight promise.
 * - A `null` fetch result is treated as "do not cache" (e.g. a transient or
 *   unauthenticated state) and the `fallback` is returned instead.
 *
 * Used by the service worker so repeated `focusin` events on a password field
 * do not each trigger a full credential re-decrypt.
 */
export function createCachedLookup<T>(options: {
  fetcher: (key: string) => Promise<T | null>;
  ttlMs: number;
  fallback: T;
  now?: () => number;
}): CachedLookup<T> {
  const cache = new TtlCache<T>(options.ttlMs, options.now);
  const inFlight = new Map<string, Promise<T>>();

  const lookup = ((key: string): Promise<T> => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const run = options
      .fetcher(key)
      .then((value) => {
        if (value !== null) {
          cache.set(key, value);
        }
        return value ?? options.fallback;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, run);
    return run;
  }) as CachedLookup<T>;

  lookup.invalidate = () => cache.clear();
  return lookup;
}
