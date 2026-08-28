import path from 'path';
import fs from 'fs';
import { StorageBackend, RateLimitRecord } from '../types';

/**
 * SQLite persistent storage backend via sql.js (pure WebAssembly — no native bindings).
 *
 * State survives process restarts and is written to disk automatically.
 * Use this when you need durability or are running behind a single-process server.
 * For multi-instance deployments, replace with a shared store (Redis, Postgres, etc.).
 *
 * The DB is flushed to disk every `flushIntervalMs` milliseconds (default 5 s),
 * as well as on every write to minimise data loss on crash.
 */
export class SQLiteStore implements StorageBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  private dbPath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<void>;

  constructor(dbPath = path.join(process.cwd(), 'data', 'rate_limits.db')) {
    this.dbPath = dbPath;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    // sql.js is a CommonJS module — dynamic import works for both ESM and CJS
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Load existing DB from disk if present, otherwise create fresh
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key         TEXT PRIMARY KEY,
        client_id   TEXT NOT NULL,
        endpoint    TEXT NOT NULL,
        count       INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        tokens      REAL,
        last_refill INTEGER,
        updated_at  INTEGER NOT NULL
      )
    `);

    // Periodic flush to disk
    this.flushTimer = setInterval(() => this.persist(), 5_000);
  }

  private persist(): void {
    if (!this.db) return;
    const data: Uint8Array = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  async get(key: string): Promise<RateLimitRecord | null> {
    await this.ready;
    const stmt = this.db.prepare(
      'SELECT * FROM rate_limits WHERE key = :key'
    );
    stmt.bind({ ':key': key });
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject({});
    stmt.free();

    return {
      clientId: row['client_id'] as string,
      endpoint: row['endpoint'] as string,
      count: row['count'] as number,
      windowStart: row['window_start'] as number,
      tokens: row['tokens'] != null ? (row['tokens'] as number) : undefined,
      lastRefill: row['last_refill'] != null ? (row['last_refill'] as number) : undefined,
    };
  }

  async set(key: string, record: RateLimitRecord): Promise<void> {
    await this.ready;
    this.db.run(
      `INSERT INTO rate_limits (key, client_id, endpoint, count, window_start, tokens, last_refill, updated_at)
       VALUES (:key, :clientId, :endpoint, :count, :windowStart, :tokens, :lastRefill, :now)
       ON CONFLICT(key) DO UPDATE SET
         count        = :count,
         window_start = :windowStart,
         tokens       = :tokens,
         last_refill  = :lastRefill,
         updated_at   = :now`,
      {
        ':key': key,
        ':clientId': record.clientId,
        ':endpoint': record.endpoint,
        ':count': record.count,
        ':windowStart': record.windowStart,
        ':tokens': record.tokens ?? null,
        ':lastRefill': record.lastRefill ?? null,
        ':now': Date.now(),
      }
    );
    // Write-through: persist on every mutation to avoid data loss
    this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    this.db.run('DELETE FROM rate_limits WHERE key = :key', { ':key': key });
    this.persist();
  }

  async keys(): Promise<string[]> {
    await this.ready;
    const stmt = this.db.prepare('SELECT key FROM rate_limits');
    const keys: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject({});
      keys.push(row['key'] as string);
    }
    stmt.free();
    return keys;
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.persist();
    this.db?.close();
  }
}
