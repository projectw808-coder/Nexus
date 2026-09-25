/**
 * Circuit breaker per (connection, endpoint) — spec §7.3. Five consecutive 5xx or a 429 storm
 * (three 429s inside a minute) opens the circuit for an exponentially growing, fully jittered
 * interval capped at 30 minutes; after it elapses one probe request is let through
 * (half-open); success closes, failure re-opens with a longer interval.
 */
import type { BudgetStore } from './budget-store.ts';
import type { CircuitState } from '../quota.ts';

export type BreakerDoc = {
  state: CircuitState;
  consecutiveFailures: number;
  /** Unix ms of recent 429s (pruned to the storm window). */
  recent429: number[];
  /** How many times the circuit has opened without a clean close — drives the backoff exponent. */
  openCount: number;
  /** Unix ms when an open circuit may probe. */
  until: number | null;
  lastFailureStatus: number | null;
  updatedAt: number;
};

export type BreakerOptions = {
  failureThreshold?: number; // default 5
  stormThreshold?: number; // default 3 × 429
  stormWindowMs?: number; // default 60s
  baseOpenMs?: number; // default 10s
  maxOpenMs?: number; // default 30 min
  now?: () => number;
  random?: () => number;
  ttlMs?: number; // document TTL, default 2h
};

export type CircuitDecision =
  | { allow: true; probe: boolean; state: CircuitState }
  | { allow: false; state: 'open'; until: Date };

export const breakerKey = (connectionId: string, endpoint: string): string =>
  `cb:${connectionId}:${endpoint}`;

const EMPTY: BreakerDoc = {
  state: 'closed',
  consecutiveFailures: 0,
  recent429: [],
  openCount: 0,
  until: null,
  lastFailureStatus: null,
  updatedAt: 0,
};

export class CircuitBreaker {
  private readonly o: Required<BreakerOptions>;
  constructor(
    private readonly store: BudgetStore,
    opts: BreakerOptions = {},
  ) {
    this.o = {
      failureThreshold: opts.failureThreshold ?? 5,
      stormThreshold: opts.stormThreshold ?? 3,
      stormWindowMs: opts.stormWindowMs ?? 60_000,
      baseOpenMs: opts.baseOpenMs ?? 10_000,
      maxOpenMs: opts.maxOpenMs ?? 30 * 60_000,
      now: opts.now ?? (() => Date.now()),
      random: opts.random ?? Math.random,
      ttlMs: opts.ttlMs ?? 2 * 3600_000,
    };
  }

  /** Called before every request. Transitions open → half_open when the wait has elapsed. */
  async check(connectionId: string, endpoint: string): Promise<CircuitDecision> {
    const now = this.o.now();
    return this.store.update<BreakerDoc, CircuitDecision>(
      breakerKey(connectionId, endpoint),
      this.o.ttlMs,
      (cur) => {
        const doc = cur ?? EMPTY;
        if (doc.state === 'closed')
          return { next: cur, result: { allow: true, probe: false, state: 'closed' } };
        if (doc.state === 'half_open') {
          // A probe is already in flight; hold everything else until it reports.
          return {
            next: doc,
            result: { allow: false, state: 'open', until: new Date(doc.until ?? now) },
          };
        }
        if (doc.until !== null && now >= doc.until) {
          return {
            next: { ...doc, state: 'half_open', updatedAt: now },
            result: { allow: true, probe: true, state: 'half_open' },
          };
        }
        return {
          next: doc,
          result: { allow: false, state: 'open', until: new Date(doc.until ?? now) },
        };
      },
    );
  }

  async recordSuccess(connectionId: string, endpoint: string): Promise<void> {
    await this.store.update<BreakerDoc, void>(
      breakerKey(connectionId, endpoint),
      this.o.ttlMs,
      (cur) => {
        if (
          !cur ||
          (cur.state === 'closed' && cur.consecutiveFailures === 0 && cur.recent429.length === 0)
        ) {
          return { next: null, result: undefined };
        }
        return { next: null, result: undefined }; // closed with clean counters == absent
      },
    );
  }

  /** Record a 5xx, 408, 429 or transport failure. Returns the new state. */
  async recordFailure(
    connectionId: string,
    endpoint: string,
    status: number | null,
  ): Promise<BreakerDoc> {
    const now = this.o.now();
    return this.store.update<BreakerDoc, BreakerDoc>(
      breakerKey(connectionId, endpoint),
      this.o.ttlMs,
      (cur) => {
        const doc: BreakerDoc = { ...(cur ?? EMPTY), recent429: [...(cur?.recent429 ?? [])] };
        const is429 = status === 429;
        if (is429) {
          doc.recent429 = doc.recent429.filter((t) => now - t < this.o.stormWindowMs);
          doc.recent429.push(now);
        } else {
          doc.consecutiveFailures += 1;
        }
        doc.lastFailureStatus = status;
        doc.updatedAt = now;
        const storm = doc.recent429.length >= this.o.stormThreshold;
        const streak = doc.consecutiveFailures >= this.o.failureThreshold;
        if (doc.state === 'half_open' || storm || streak) {
          doc.openCount += 1;
          const ceiling = Math.min(this.o.maxOpenMs, this.o.baseOpenMs * 2 ** (doc.openCount - 1));
          // Full jitter but never less than a quarter of the ceiling, so "open" always means a real pause.
          const wait = Math.floor(ceiling / 4 + (this.o.random() * (ceiling * 3)) / 4);
          doc.state = 'open';
          doc.until = now + wait;
          doc.consecutiveFailures = 0;
          doc.recent429 = [];
        }
        return { next: doc, result: doc };
      },
    );
  }

  async state(connectionId: string, endpoint: string): Promise<BreakerDoc> {
    return (await this.store.get<BreakerDoc>(breakerKey(connectionId, endpoint))) ?? EMPTY;
  }
}
