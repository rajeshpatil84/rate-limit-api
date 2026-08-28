export type Algorithm = 'fixed-window' | 'sliding-window' | 'token-bucket' | 'leaky-bucket';
export type StorageType = 'memory' | 'sqlite';

export interface ClientConfig {
  clientId: string;
  /** Max requests allowed per window (fixed/sliding) or token capacity (token/leaky) */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** For leaky bucket: requests drained per windowMs */
  drainRate?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;     // Unix ms when the limit resets / next token available
  limit: number;
  algorithm: Algorithm;
  storage: StorageType;
}

export interface RateLimitRecord {
  clientId: string;
  endpoint: string;
  count: number;
  windowStart: number;  // Unix ms
  tokens?: number;      // For token/leaky bucket
  lastRefill?: number;  // For token/leaky bucket
}

export interface StorageBackend {
  get(key: string): Promise<RateLimitRecord | null>;
  set(key: string, record: RateLimitRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Return all keys (for admin/debug) */
  keys(): Promise<string[]>;
  close?(): Promise<void>;
}

export interface RateLimiter {
  check(
    clientId: string,
    endpoint: string,
    config: ClientConfig
  ): Promise<RateLimitResult>;
  algorithm: Algorithm;
}
