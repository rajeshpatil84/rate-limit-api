import { RateLimiter, RateLimitResult, ClientConfig, StorageBackend, Algorithm } from '../types';

/**
 * Fixed Window Counter
 * ────────────────────
 * Divides time into fixed-size buckets (e.g. 0–10 s, 10–20 s …).
 * A counter per client+endpoint is incremented on each request.
 * When the bucket expires a fresh one starts at zero.
 *
 * Pros : simple, low memory, O(1) per check.
 * Cons : allows a burst of 2× the limit across a window boundary
 *        (last-second rush + first-second rush in next window).
 *
 * Used by: /foo endpoint
 */
export class FixedWindowLimiter implements RateLimiter {
  public readonly algorithm: Algorithm = 'fixed-window';

  constructor(private readonly storage: StorageBackend) {}

  async check(
    clientId: string,
    endpoint: string,
    config: ClientConfig
  ): Promise<RateLimitResult> {
    const key = `fw:${clientId}:${endpoint}`;
    const now = Date.now();
    const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
    const resetAt = windowStart + config.windowMs;

    let record = await this.storage.get(key);

    // New window — reset counter
    if (!record || record.windowStart !== windowStart) {
      record = {
        clientId,
        endpoint,
        count: 0,
        windowStart,
      };
    }

    const allowed = record.count < config.limit;

    if (allowed) {
      record.count += 1;
      await this.storage.set(key, record);
    }

    return {
      allowed,
      remaining: Math.max(0, config.limit - record.count),
      resetAt,
      limit: config.limit,
      algorithm: this.algorithm,
      storage: 'memory', // overridden by middleware
    };
  }
}
