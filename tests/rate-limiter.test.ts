/**
 * Rate Limiter API — Test Suite
 *
 * Covers:
 *  - Both storage backends (MemoryStore, SQLiteStore)
 *  - All four algorithms (Fixed Window, Sliding Window, Token Bucket, Leaky Bucket)
 *  - Express endpoint integration tests (/foo, /bar, /memory/*, /sqlite/*)
 *  - Auth validation (missing / malformed / unknown client)
 *  - Admin endpoints
 *  - Multi-client isolation (client-1 vs client-2 limits)
 */

import request from 'supertest';
import { createApp } from '../src/app';
import { MemoryStore } from '../src/storage/memory.store';
import { FixedWindowLimiter } from '../src/algorithms/fixed-window';
import { SlidingWindowLimiter } from '../src/algorithms/sliding-window';
import { TokenBucketLimiter } from '../src/algorithms/token-bucket';
import { LeakyBucketLimiter } from '../src/algorithms/leaky-bucket';
import { ClientConfig } from '../src/types';
import path from 'path';
import fs from 'fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_CONFIG: ClientConfig = {
  clientId: 'test-client',
  limit: 3,
  windowMs: 10_000,
  drainRate: 1,
};

const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'test_rate_limits.db');

function cleanupTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
}

// ─── Unit: MemoryStore ────────────────────────────────────────────────────────

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('returns null for unknown key', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('stores and retrieves a record', async () => {
    const record = { clientId: 'c1', endpoint: '/foo', count: 2, windowStart: Date.now() };
    await store.set('key1', record);
    const retrieved = await store.get('key1');
    expect(retrieved).toMatchObject({ clientId: 'c1', count: 2 });
  });

  it('overwrites an existing record', async () => {
    const base = { clientId: 'c1', endpoint: '/foo', count: 1, windowStart: Date.now() };
    await store.set('key1', base);
    await store.set('key1', { ...base, count: 5 });
    expect((await store.get('key1'))!.count).toBe(5);
  });

  it('deletes a record', async () => {
    await store.set('key1', { clientId: 'c1', endpoint: '/foo', count: 1, windowStart: Date.now() });
    await store.delete('key1');
    expect(await store.get('key1')).toBeNull();
  });

  it('lists all keys', async () => {
    await store.set('a', { clientId: 'c', endpoint: '/foo', count: 0, windowStart: 0 });
    await store.set('b', { clientId: 'c', endpoint: '/bar', count: 0, windowStart: 0 });
    const keys = await store.keys();
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('flush clears all records', async () => {
    await store.set('k', { clientId: 'c', endpoint: '/foo', count: 1, windowStart: 0 });
    store.flush();
    expect(store.size).toBe(0);
  });
});

// ─── Unit: Fixed Window ────────────────────────────────────────────────────────

describe('FixedWindowLimiter', () => {
  let store: MemoryStore;
  let limiter: FixedWindowLimiter;

  beforeEach(() => {
    store = new MemoryStore();
    limiter = new FixedWindowLimiter(store);
  });

  it('reports algorithm as fixed-window', () => {
    expect(limiter.algorithm).toBe('fixed-window');
  });

  it('allows requests below the limit', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      const result = await limiter.check('test-client', '/foo', TEST_CONFIG);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(TEST_CONFIG.limit - (i + 1));
    }
  });

  it('blocks the request that exceeds the limit', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('test-client', '/foo', TEST_CONFIG);
    }
    const result = await limiter.check('test-client', '/foo', TEST_CONFIG);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('does not consume a token when blocked', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('test-client', '/foo', TEST_CONFIG);
    }
    // Two blocked calls
    const r1 = await limiter.check('test-client', '/foo', TEST_CONFIG);
    const r2 = await limiter.check('test-client', '/foo', TEST_CONFIG);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it('isolates counters between clients', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('client-a', '/foo', TEST_CONFIG);
    }
    // client-a is blocked, client-b should still be allowed
    const blocked = await limiter.check('client-a', '/foo', TEST_CONFIG);
    const allowed = await limiter.check('client-b', '/foo', TEST_CONFIG);
    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it('isolates counters between endpoints', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('test-client', '/foo', TEST_CONFIG);
    }
    const fooBlocked = await limiter.check('test-client', '/foo', TEST_CONFIG);
    const barAllowed = await limiter.check('test-client', '/bar', TEST_CONFIG);
    expect(fooBlocked.allowed).toBe(false);
    expect(barAllowed.allowed).toBe(true);
  });

  it('resets after the window expires', async () => {
    const shortConfig: ClientConfig = { ...TEST_CONFIG, windowMs: 50 };
    for (let i = 0; i < shortConfig.limit; i++) {
      await limiter.check('test-client', '/foo', shortConfig);
    }
    expect((await limiter.check('test-client', '/foo', shortConfig)).allowed).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));
    expect((await limiter.check('test-client', '/foo', shortConfig)).allowed).toBe(true);
  });
});

// ─── Unit: Sliding Window ──────────────────────────────────────────────────────

describe('SlidingWindowLimiter', () => {
  let store: MemoryStore;
  let limiter: SlidingWindowLimiter;

  beforeEach(() => {
    store = new MemoryStore();
    limiter = new SlidingWindowLimiter(store);
  });

  it('reports algorithm as sliding-window', () => {
    expect(limiter.algorithm).toBe('sliding-window');
  });

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      const r = await limiter.check('test-client', '/bar', TEST_CONFIG);
      expect(r.allowed).toBe(true);
    }
  });

  it('blocks the (limit+1)th request', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('test-client', '/bar', TEST_CONFIG);
    }
    const r = await limiter.check('test-client', '/bar', TEST_CONFIG);
    expect(r.allowed).toBe(false);
  });

  it('allows a new request once an old timestamp slides out', async () => {
    const shortConfig: ClientConfig = { ...TEST_CONFIG, limit: 2, windowMs: 100 };
    await limiter.check('test-client', '/bar', shortConfig); // t=0
    await new Promise((r) => setTimeout(r, 60));
    await limiter.check('test-client', '/bar', shortConfig); // t=60ms — both in window
    const blocked = await limiter.check('test-client', '/bar', shortConfig); // t=60ms, 3rd = blocked
    expect(blocked.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 50)); // t=110ms — first timestamp (t=0) has slid out
    const allowed = await limiter.check('test-client', '/bar', shortConfig);
    expect(allowed.allowed).toBe(true);
  });

  it('isolates clients', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('c1', '/bar', TEST_CONFIG);
    }
    expect((await limiter.check('c1', '/bar', TEST_CONFIG)).allowed).toBe(false);
    expect((await limiter.check('c2', '/bar', TEST_CONFIG)).allowed).toBe(true);
  });
});

// ─── Unit: Token Bucket ────────────────────────────────────────────────────────

describe('TokenBucketLimiter', () => {
  let store: MemoryStore;
  let limiter: TokenBucketLimiter;

  beforeEach(() => {
    store = new MemoryStore();
    limiter = new TokenBucketLimiter(store);
  });

  it('starts with a full bucket', async () => {
    const r = await limiter.check('test-client', '/baz', TEST_CONFIG);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(TEST_CONFIG.limit - 1);
  });

  it('blocks when bucket is empty', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('test-client', '/baz', TEST_CONFIG);
    }
    const r = await limiter.check('test-client', '/baz', TEST_CONFIG);
    expect(r.allowed).toBe(false);
  });

  it('refills tokens over time', async () => {
    const fastConfig: ClientConfig = { ...TEST_CONFIG, limit: 2, windowMs: 100 };
    await limiter.check('test-client', '/baz', fastConfig);
    await limiter.check('test-client', '/baz', fastConfig);
    expect((await limiter.check('test-client', '/baz', fastConfig)).allowed).toBe(false);

    // Wait for >1 token to refill
    await new Promise((r) => setTimeout(r, 60));
    expect((await limiter.check('test-client', '/baz', fastConfig)).allowed).toBe(true);
  });
});

// ─── Unit: Leaky Bucket ────────────────────────────────────────────────────────

describe('LeakyBucketLimiter', () => {
  let store: MemoryStore;
  let limiter: LeakyBucketLimiter;

  beforeEach(() => {
    store = new MemoryStore();
    limiter = new LeakyBucketLimiter(store);
  });

  it('allows initial requests', async () => {
    const r = await limiter.check('test-client', '/qux', TEST_CONFIG);
    expect(r.allowed).toBe(true);
  });

  it('blocks when bucket overflows', async () => {
    for (let i = 0; i < TEST_CONFIG.limit; i++) {
      await limiter.check('test-client', '/qux', TEST_CONFIG);
    }
    const r = await limiter.check('test-client', '/qux', TEST_CONFIG);
    expect(r.allowed).toBe(false);
  });
});

// ─── Integration: Express App ──────────────────────────────────────────────────

describe('API integration tests', () => {
  let app: ReturnType<typeof createApp>['app'];
  let memoryStore: MemoryStore;

  beforeAll(() => {
    cleanupTestDb();
  });

  beforeEach(() => {
    memoryStore = new MemoryStore();
    ({ app } = createApp({ memoryStore, sqliteDbPath: TEST_DB_PATH }));
  });

  afterAll(() => {
    cleanupTestDb();
  });

  // ── Auth validation ──────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/foo');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing Authorization/);
    });

    it('returns 401 for malformed Authorization header', async () => {
      const res = await request(app).get('/foo').set('Authorization', 'Basic abc123');
      expect(res.status).toBe(401);
    });

    it('returns 403 for an unknown client', async () => {
      const res = await request(app).get('/foo').set('Authorization', 'Bearer unknown-client-xyz');
      expect(res.status).toBe(403);
    });
  });

  // ── /foo (Fixed Window, memory) ──────────────────────────────────────────

  describe('GET /foo — Fixed Window', () => {
    it('returns 200 { success: true } within rate limit', async () => {
      const res = await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('includes X-RateLimit-* response headers', async () => {
      const res = await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      expect(res.headers['x-ratelimit-algorithm']).toBe('fixed-window');
    });

    it('returns 429 { error: "rate limit exceeded" } once limit is reached', async () => {
      // client-1 has limit=5 per 10s
      for (let i = 0; i < 5; i++) {
        await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      }
      const res = await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: 'rate limit exceeded' });
    });

    it('includes Retry-After header on 429', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      }
      const res = await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  // ── /bar (Sliding Window, memory) ────────────────────────────────────────

  describe('GET /bar — Sliding Window', () => {
    it('returns 200 within rate limit', async () => {
      const res = await request(app).get('/bar').set('Authorization', 'Bearer client-2');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('uses sliding-window algorithm', async () => {
      const res = await request(app).get('/bar').set('Authorization', 'Bearer client-2');
      expect(res.headers['x-ratelimit-algorithm']).toBe('sliding-window');
    });

    it('returns 429 once client-2 limit (10) is exceeded', async () => {
      for (let i = 0; i < 10; i++) {
        await request(app).get('/bar').set('Authorization', 'Bearer client-2');
      }
      const res = await request(app).get('/bar').set('Authorization', 'Bearer client-2');
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: 'rate limit exceeded' });
    });
  });

  // ── Multi-client isolation ────────────────────────────────────────────────

  describe('Multi-client isolation', () => {
    it('client-1 hitting limit does not affect client-2', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      }
      // client-1 now blocked
      const c1 = await request(app).get('/foo').set('Authorization', 'Bearer client-1');
      expect(c1.status).toBe(429);

      // client-2 should still be fine (has its own counter)
      const c2 = await request(app).get('/foo').set('Authorization', 'Bearer client-2');
      expect(c2.status).toBe(200);
    });

    it('client-free has a stricter limit than client-premium', async () => {
      // client-free: limit=2
      await request(app).get('/foo').set('Authorization', 'Bearer client-free');
      await request(app).get('/foo').set('Authorization', 'Bearer client-free');
      const free = await request(app).get('/foo').set('Authorization', 'Bearer client-free');
      expect(free.status).toBe(429);

      // client-premium: limit=100 — still has plenty of tokens
      const premium = await request(app).get('/foo').set('Authorization', 'Bearer client-premium');
      expect(premium.status).toBe(200);
    });
  });

  // ── Storage prefix routes ─────────────────────────────────────────────────

  describe('Storage prefix routes', () => {
    it('GET /memory/foo uses in-memory storage', async () => {
      const res = await request(app).get('/memory/foo').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-storage']).toBe('memory');
    });

    it('GET /sqlite/foo uses SQLite storage', async () => {
      const res = await request(app).get('/sqlite/foo').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-storage']).toBe('sqlite');
    });

    it('memory and SQLite counters are independent', async () => {
      // Exhaust client-1 on memory prefix
      for (let i = 0; i < 5; i++) {
        await request(app).get('/memory/foo').set('Authorization', 'Bearer client-1');
      }
      const memBlocked = await request(app).get('/memory/foo').set('Authorization', 'Bearer client-1');
      expect(memBlocked.status).toBe(429);

      // SQLite counter should still have room
      const sqliteOk = await request(app).get('/sqlite/foo').set('Authorization', 'Bearer client-1');
      expect(sqliteOk.status).toBe(200);
    });
  });

  // ── Bonus endpoints ───────────────────────────────────────────────────────

  describe('Bonus endpoints', () => {
    it('GET /sqlite/baz — Token Bucket — returns 200', async () => {
      const res = await request(app).get('/sqlite/baz').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-algorithm']).toBe('token-bucket');
    });

    it('GET /sqlite/qux — Leaky Bucket — returns 200', async () => {
      const res = await request(app).get('/sqlite/qux').set('Authorization', 'Bearer client-1');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-algorithm']).toBe('leaky-bucket');
    });
  });

  // ── Admin routes ──────────────────────────────────────────────────────────

  describe('Admin routes', () => {
    it('GET /admin/health returns ok', async () => {
      const res = await request(app).get('/admin/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /admin/clients lists registered clients', async () => {
      const res = await request(app).get('/admin/clients');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('client-1');
      expect(res.body).toHaveProperty('client-2');
    });

    it('GET /admin/state/memory returns key list', async () => {
      await request(app).get('/memory/foo').set('Authorization', 'Bearer client-1');
      const res = await request(app).get('/admin/state/memory');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.keys)).toBe(true);
    });
  });

  // ── 404 ──────────────────────────────────────────────────────────────────

  describe('Not Found', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(app).get('/unknown-route');
      expect(res.status).toBe(404);
    });
  });
});
