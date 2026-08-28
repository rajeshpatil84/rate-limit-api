import { RateLimiter, RateLimitResult, ClientConfig, StorageBackend, Algorithm } from '../types';

/**
 * Token Bucket
 * ────────────
 * Each client has a bucket that holds up to `limit` tokens.
 * Tokens refill continuously at a rate of `limit / windowMs` tokens per ms.
 * A request consumes one token; if the bucket is empty the request is rejected.
 *
 * Pros : allows short bursts (up to bucket capacity) while enforcing an
 *        average rate over time. Widely used in real APIs (e.g. AWS, Stripe).
 * Cons : slightly more complex state (tokens + lastRefill timestamp).
 *
 * Bonus algorithm beyond the two required by the spec.
 */
export class TokenBucketLimiter implements RateLimiter {
  public readonly algorithm: Algorithm = 'token-bucket';

  constructor(private readonly storage: StorageBackend) {}

  async check(
    clientId: string,
    endpoint: string,
    config: ClientConfig
  ): Promise<RateLimitResult> {
    const key = `tb:${clientId}:${endpoint}`;
    const now = Date.now();
    const refillRate = config.limit / config.windowMs; // tokens per ms

    let record = await this.storage.get(key);

    let tokens: number;
    let lastRefill: number;

    if (!record || record.tokens == null || record.lastRefill == null) {
      // First request — full bucket
      tokens = config.limit;
      lastRefill = now;
    } else {
      // Refill tokens based on elapsed time
      const elapsed = now - record.lastRefill;
      tokens = Math.min(config.limit, record.tokens + elapsed * refillRate);
      lastRefill = now;
    }

    const allowed = tokens >= 1;

    if (allowed) {
      tokens -= 1;
    }

    await this.storage.set(key, {
      clientId,
      endpoint,
      count: 0, // unused for token bucket
      windowStart: now,
      tokens,
      lastRefill,
    });

    // Estimate when the next token arrives (if bucket was empty)
    const msUntilNextToken = allowed ? 0 : Math.ceil((1 - tokens) / refillRate);
    const resetAt = now + msUntilNextToken;

    return {
      allowed,
      remaining: Math.floor(tokens),
      resetAt,
      limit: config.limit,
      algorithm: this.algorithm,
      storage: 'memory',
    };
  }
}
