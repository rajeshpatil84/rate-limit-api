import { Router, Request, Response } from 'express';
import { rateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { FixedWindowLimiter } from '../algorithms/fixed-window';
import { SlidingWindowLimiter } from '../algorithms/sliding-window';
import { TokenBucketLimiter } from '../algorithms/token-bucket';
import { LeakyBucketLimiter } from '../algorithms/leaky-bucket';
import { MemoryStore } from '../storage/memory.store';
import { SQLiteStore } from '../storage/sqlite.store';
import { StorageBackend, StorageType } from '../types';
import { getAllClientConfigs } from '../config/clients';

/**
 * Creates the full API router given the desired storage backend.
 *
 * Storage is injected so the same route tree can be mounted twice —
 * once with memory storage (prefix /memory) and once with SQLite (prefix /sqlite).
 */
export function createApiRouter(
  storage: StorageBackend,
  storageType: StorageType
): Router {
  const router = Router();

  // Instantiate limiters backed by the provided storage
  const fixedWindowLimiter = new FixedWindowLimiter(storage);
  const slidingWindowLimiter = new SlidingWindowLimiter(storage);
  const tokenBucketLimiter = new TokenBucketLimiter(storage);
  const leakyBucketLimiter = new LeakyBucketLimiter(storage);

  /**
   * GET /foo
   * Uses Fixed Window rate limiting.
   */
  router.get(
    '/foo',
    rateLimitMiddleware(fixedWindowLimiter, storageType),
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    }
  );

  /**
   * GET /bar
   * Uses Sliding Window rate limiting.
   */
  router.get(
    '/bar',
    rateLimitMiddleware(slidingWindowLimiter, storageType),
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    }
  );

  /**
   * GET /baz  (bonus)
   * Uses Token Bucket rate limiting — demonstrates burst-friendly behaviour.
   */
  router.get(
    '/baz',
    rateLimitMiddleware(tokenBucketLimiter, storageType),
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    }
  );

  /**
   * GET /qux  (bonus)
   * Uses Leaky Bucket rate limiting — enforces a smooth constant rate.
   */
  router.get(
    '/qux',
    rateLimitMiddleware(leakyBucketLimiter, storageType),
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    }
  );

  return router;
}

/**
 * Admin / observability router — no rate limiting applied here.
 */
export function createAdminRouter(
  memoryStore: MemoryStore,
  sqliteStore: SQLiteStore
): Router {
  const router = Router();

  /** Health check */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  /** List all registered clients and their configs */
  router.get('/clients', (_req: Request, res: Response) => {
    res.json(getAllClientConfigs());
  });

  /** Show current in-memory rate limit state */
  router.get('/state/memory', async (_req: Request, res: Response) => {
    const keys = await memoryStore.keys();
    res.json({ storage: 'memory', keys, count: keys.length });
  });

  /** Show current SQLite rate limit state */
  router.get('/state/sqlite', async (_req: Request, res: Response) => {
    const keys = await sqliteStore.keys();
    res.json({ storage: 'sqlite', keys, count: keys.length });
  });

  return router;
}
