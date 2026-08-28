import { StorageBackend, RateLimitRecord } from '../types';

/**
 * In-memory storage backend.
 * Fast, zero-dependency — but state is lost on process restart
 * and not shared between multiple instances.
 */
export class MemoryStore implements StorageBackend {
  private store = new Map<string, RateLimitRecord>();

  async get(key: string): Promise<RateLimitRecord | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, record: RateLimitRecord): Promise<void> {
    this.store.set(key, { ...record });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }

  /** Expose raw store size for testing */
  get size(): number {
    return this.store.size;
  }

  /** Flush all records — useful in tests */
  flush(): void {
    this.store.clear();
  }
}
