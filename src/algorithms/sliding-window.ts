import { RateLimiter, RateLimitResult, ClientConfig, StorageBackend, Algorithm } from '../types';

/**
 * Sliding Window Log
 * ──────────────────
 * Stores a sorted list of request timestamps for each client+endpoint.
 * On each request, timestamps older than `windowMs` are pruned before
 * counting — so the window truly slides with every request.
 *
 * Pros : no boundary-burst problem; extremely accurate.
 * Cons : memory grows proportionally to request volume (mitigated by pruning).
 *
 * Used by: /bar endpoint
 *
 * Implementation note: we serialise the timestamp log into the `count` field
 * as a JSON string stored in `windowStart` position.  A proper production
 * store would use a Redis sorted-set or a dedicated column.  Here we keep
 * the StorageBackend interface generic, so we overload `windowStart` to hold
 * the serialised log for compatibility with both backends.
 */
export class SlidingWindowLimiter implements RateLimiter {
  public readonly algorithm: Algorithm = 'sliding-window';

  constructor(private readonly storage: StorageBackend) {}

  async check(
    clientId: string,
    endpoint: string,
    config: ClientConfig
  ): Promise<RateLimitResult> {
    const key = `sw:${clientId}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const record = await this.storage.get(key);

    // Deserialise timestamp log from the stored record
    let timestamps: number[] = [];
    if (record) {
      try {
        // We store the JSON-serialised list in the `windowStart` field (repurposed)
        timestamps = JSON.parse(String(record.windowStart)) as number[];
      } catch {
        timestamps = [];
      }
    }

    // Prune timestamps outside the current window
    timestamps = timestamps.filter((ts) => ts > windowStart);

    const allowed = timestamps.length < config.limit;
    const resetAt = timestamps.length > 0 ? timestamps[0] + config.windowMs : now + config.windowMs;

    if (allowed) {
      timestamps.push(now);
      await this.storage.set(key, {
        clientId,
        endpoint,
        count: timestamps.length,
        windowStart: JSON.stringify(timestamps) as unknown as number,
      });
    }

    return {
      allowed,
      remaining: Math.max(0, config.limit - timestamps.length),
      resetAt,
      limit: config.limit,
      algorithm: this.algorithm,
      storage: 'memory',
    };
  }
}
