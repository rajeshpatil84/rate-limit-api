import { RateLimiter, RateLimitResult, ClientConfig, StorageBackend, Algorithm } from '../types';

/**
 * Leaky Bucket
 * ────────────
 * Models a bucket with a hole in the bottom: requests fill the bucket and
 * "leak out" at a constant drain rate.  If the bucket overflows (count > limit)
 * the request is rejected.
 *
 * Unlike the Token Bucket, the Leaky Bucket enforces a *smooth, constant output
 * rate* rather than allowing short bursts.  It's used in traffic-shaping and
 * network QoS.
 *
 * Pros : smooths out bursty traffic; predictable downstream load.
 * Cons : a sudden burst is always rejected even if the bucket was recently empty.
 *
 * Bonus algorithm beyond the two required by the spec.
 */
export class LeakyBucketLimiter implements RateLimiter {
  public readonly algorithm: Algorithm = 'leaky-bucket';

  constructor(private readonly storage: StorageBackend) {}

  async check(
    clientId: string,
    endpoint: string,
    config: ClientConfig
  ): Promise<RateLimitResult> {
    const key = `lb:${clientId}:${endpoint}`;
    const now = Date.now();
    const drainRate = (config.drainRate ?? 1) / config.windowMs; // units per ms

    let record = await this.storage.get(key);

    let level: number;   // current water level (pending requests)
    let lastRefill: number;

    if (!record || record.tokens == null || record.lastRefill == null) {
      level = 0;
      lastRefill = now;
    } else {
      // Drain since last check
      const elapsed = now - record.lastRefill;
      level = Math.max(0, record.tokens - elapsed * drainRate);
      lastRefill = now;
    }

    const allowed = level < config.limit;

    if (allowed) {
      level += 1; // incoming request fills bucket by 1
    }

    await this.storage.set(key, {
      clientId,
      endpoint,
      count: Math.ceil(level),
      windowStart: now,
      tokens: level,
      lastRefill,
    });

    // Estimate when level drops below limit (if bucket is full)
    const msUntilDrained = allowed
      ? 0
      : Math.ceil((level - config.limit + 1) / drainRate);
    const resetAt = now + msUntilDrained;

    return {
      allowed,
      remaining: Math.max(0, config.limit - Math.ceil(level)),
      resetAt,
      limit: config.limit,
      algorithm: this.algorithm,
      storage: 'memory',
    };
  }
}
