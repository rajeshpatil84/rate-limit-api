import { Request, Response, NextFunction } from 'express';
import { RateLimiter, StorageType } from '../types';
import { getClientConfig } from '../config/clients';
import { logger } from '../utils/logger';

/**
 * Express middleware factory that applies a given rate limiter to an endpoint.
 *
 * It:
 *  1. Extracts and validates the `Authorization: Bearer <clientId>` header.
 *  2. Looks up the per-client configuration.
 *  3. Delegates to the chosen RateLimiter algorithm.
 *  4. Attaches RFC-standard rate-limit response headers.
 *  5. Returns 429 with a JSON body when the limit is exceeded.
 */
export function rateLimitMiddleware(
  limiter: RateLimiter,
  storageType: StorageType
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── 1. Extract client ID from Authorization header ──────────────────────
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const match = authHeader.match(/^[Bb]earer\s+(.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Invalid Authorization header format. Expected: Bearer <client-id>' });
      return;
    }

    const clientId = match[1].trim();

    // ── 2. Look up client configuration ──────────────────────────────────────
    const config = getClientConfig(clientId);
    if (!config) {
      res.status(403).json({ error: `Unknown client: ${clientId}` });
      return;
    }

    // ── 3. Run rate limit check ───────────────────────────────────────────────
    const endpoint = req.path;
    let result;
    try {
      result = await limiter.check(clientId, endpoint, config);
    } catch (err) {
      logger.error('Rate limiter error', { err, clientId, endpoint });
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Override the storage label with the actual backend in use
    result.storage = storageType;

    // ── 4. Set standard rate-limit headers ───────────────────────────────────
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000)); // Unix seconds
    res.setHeader('X-RateLimit-Algorithm', result.algorithm);
    res.setHeader('X-RateLimit-Storage', result.storage);

    if (!result.allowed) {
      const retryAfterSecs = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', retryAfterSecs);

      logger.warn('Rate limit exceeded', { clientId, endpoint, algorithm: result.algorithm });

      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    logger.info('Request allowed', {
      clientId,
      endpoint,
      remaining: result.remaining,
      algorithm: result.algorithm,
      storage: result.storage,
    });

    next();
  };
}
