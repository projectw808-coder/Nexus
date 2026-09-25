/**
 * Redis-backed `BudgetStore` (spec §3: Redis is the rate-budget store). Atomicity comes from a
 * compare-and-set Lua script: read → compute in TypeScript → `SET` only if the document is
 * unchanged, retrying on contention. Documents are tiny and contention is per connection, so
 * the retry loop converges in one or two rounds.
 *
 * The client type is structural (the subset of ioredis we use) so this package does not
 * depend on ioredis; the worker and web tier pass their existing connection.
 */
import type { BudgetStore } from './budget-store.ts';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    n: number,
  ): Promise<[string, string[]]>;
}

const CAS_SET = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end
  return 1
end
return 0`;

const CAS_DEL_IF_ABSENT = 'return 1';

export class RedisBudgetStore implements BudgetStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = 'nexus:budget:',
    private readonly maxRounds = 25,
  ) {}

  private k(key: string): string {
    return this.prefix + key;
  }

  async update<T, R>(
    key: string,
    ttlMs: number,
    fn: (current: T | null) => { next: T | null; result: R },
  ): Promise<R> {
    const rk = this.k(key);
    for (let round = 0; round < this.maxRounds; round++) {
      const raw = await this.redis.get(rk);
      const current = raw === null ? null : (JSON.parse(raw) as T);
      const { next, result } = fn(current);
      const encoded = next === null ? '' : JSON.stringify(next);
      if (raw === null) {
        if (next === null) {
          await this.redis.eval(CAS_DEL_IF_ABSENT, 0);
          return result;
        }
        const ok = await this.redis.set(rk, encoded, 'PX', Math.max(1, ttlMs), 'NX');
        if (ok === 'OK') return result;
      } else {
        const ok = await this.redis.eval(CAS_SET, 1, rk, raw, encoded, Math.max(1, ttlMs));
        if (ok === 1) return result;
      }
    }
    throw new Error(`budget store: could not update ${key} after ${this.maxRounds} rounds`);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.k(key));
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.k(prefix)}*`,
        'COUNT',
        200,
      );
      for (const k of batch) out.push(k.slice(this.prefix.length));
      cursor = next;
    } while (cursor !== '0');
    return out;
  }
}
