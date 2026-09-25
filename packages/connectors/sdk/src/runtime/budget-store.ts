/**
 * Storage for the rate limiter and circuit breaker. The limiter keeps every window, ledger and
 * breaker as a small JSON document and mutates it through `update()`, an atomic
 * read-modify-write. That keeps the quota arithmetic in one TypeScript module (unit-testable
 * against the in-memory store) while Redis supplies atomicity through a compare-and-set script
 * (`redis-budget-store.ts`).
 */

export interface BudgetStore {
  /**
   * Atomically transform the document at `key`. `fn` must be pure: the Redis implementation
   * re-invokes it when another writer won the race. Returning `next: null` deletes the key.
   */
  update<T, R>(
    key: string,
    ttlMs: number,
    fn: (current: T | null) => { next: T | null; result: R },
  ): Promise<R>;
  get<T>(key: string): Promise<T | null>;
  /** Keys with the given prefix — used by snapshots. Small cardinality per connection. */
  keys(prefix: string): Promise<string[]>;
}

/** In-process store for tests, the inline (no-Redis) mode and single-process deployments. */
export class MemoryBudgetStore implements BudgetStore {
  private readonly docs = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  private read(key: string): string | null {
    const d = this.docs.get(key);
    if (!d) return null;
    if (d.expiresAt <= this.now()) {
      this.docs.delete(key);
      return null;
    }
    return d.value;
  }

  async update<T, R>(
    key: string,
    ttlMs: number,
    fn: (current: T | null) => { next: T | null; result: R },
  ): Promise<R> {
    const raw = this.read(key);
    const current = raw === null ? null : (JSON.parse(raw) as T);
    const { next, result } = fn(current);
    if (next === null) this.docs.delete(key);
    else this.docs.set(key, { value: JSON.stringify(next), expiresAt: this.now() + ttlMs });
    return result;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = this.read(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.docs.keys())
      if (k.startsWith(prefix) && this.read(k) !== null) out.push(k);
    return out;
  }

  /** Test helper. */
  clear(): void {
    this.docs.clear();
  }
}
