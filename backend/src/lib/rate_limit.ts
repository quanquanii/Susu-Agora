// Simple in-process sliding-window rate limiter.
//
// Why in-process and not Postgres / Redis:
//   - Single Fly machine in v0.1; horizontal scale = "swap to Redis later".
//   - We're protecting against opportunistic abuse during BETA, not a
//     determined attacker. A best-effort per-process counter shaves 99% of
//     the spam vector at zero infra cost.
//   - When we add a 2nd machine, the limit becomes "per-machine"; that's
//     still useful (caps damage even if one node loses count).
//
// Bucket key shape is caller-defined: "address:signal_push" / "ip:auth_nonce" / etc.

interface Bucket {
  // Timestamps (ms) of recent calls, rolling.
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimit {
  windowMs: number;
  max: number;
}

export class RateLimitedError extends Error {
  constructor(public retryAfterSec: number) {
    super("rate_limited");
  }
}

/** Throw RateLimitedError if `key` has hit `limit.max` calls within
 *  `limit.windowMs`. Otherwise record the call and return.
 *  The bucket auto-prunes old hits.
 */
export function check(key: string, limit: RateLimit): void {
  const now = Date.now();
  const cutoff = now - limit.windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  // Drop expired hits.
  while (bucket.hits.length > 0 && bucket.hits[0]! < cutoff) {
    bucket.hits.shift();
  }
  if (bucket.hits.length >= limit.max) {
    const oldest = bucket.hits[0]!;
    const retryAfter = Math.ceil((oldest + limit.windowMs - now) / 1000);
    throw new RateLimitedError(Math.max(retryAfter, 1));
  }
  bucket.hits.push(now);
}

/** Periodically prune buckets that have been empty for >5×window so the map
 *  doesn't grow unbounded. Caller invokes this from a timer at boot. */
export function startGc(intervalMs: number = 5 * 60 * 1000): { stop: () => void } {
  const id = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      // If everything in the bucket is older than 5 min, drop it.
      if (bucket.hits.length === 0 || (bucket.hits[bucket.hits.length - 1]! < now - 5 * 60 * 1000)) {
        buckets.delete(key);
      }
    }
  }, intervalMs);
  // Don't keep the process alive on this timer alone.
  if (typeof id === "object" && id !== null && "unref" in id) (id as any).unref();
  return { stop: () => clearInterval(id) };
}

/** Test helper — wipe state. */
export function _resetForTests() { buckets.clear(); }
