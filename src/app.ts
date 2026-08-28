import express, { Request, Response, NextFunction } from 'express';
import { createApiRouter, createAdminRouter } from './routes/api.routes';
import { MemoryStore } from './storage/memory.store';
import { SQLiteStore } from './storage/sqlite.store';
import { logger } from './utils/logger';

export interface AppOptions {
  /** Pre-created stores — useful for injecting test doubles */
  memoryStore?: MemoryStore;
  sqliteStore?: SQLiteStore;
  sqliteDbPath?: string;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  // ── Request logging ──────────────────────────────────────────────────────
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`, {
      authorization: req.headers['authorization'] ?? '(none)',
    });
    next();
  });

  // ── Storage backends ─────────────────────────────────────────────────────
  const memoryStore = options.memoryStore ?? new MemoryStore();
  const sqliteStore = options.sqliteStore ?? new SQLiteStore(options.sqliteDbPath);

  // ── Routes ───────────────────────────────────────────────────────────────
  // Same logical endpoints, duplicated under two prefixes for storage selection.
  // Clients choose storage by picking the URL prefix:
  //   /memory/foo  → in-memory counters
  //   /sqlite/foo  → SQLite persistent counters
  // The top-level /foo and /bar default to in-memory (for spec compliance).
  app.use('/', createApiRouter(memoryStore, 'memory'));
  app.use('/memory', createApiRouter(memoryStore, 'memory'));
  app.use('/sqlite', createApiRouter(sqliteStore, 'sqlite'));

  // Admin / observability
  app.use('/admin', createAdminRouter(memoryStore, sqliteStore));

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ── Global error handler ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', { err });
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, memoryStore, sqliteStore };
}
