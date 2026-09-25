import { describe, expect, it } from 'vitest';
import { MemoryBudgetStore } from './budget-store.ts';
import { CircuitBreaker } from './circuit-breaker.ts';

function setup() {
  let t = 1_000_000;
  const now = () => t;
  const store = new MemoryBudgetStore(now);
  const cb = new CircuitBreaker(store, {
    now,
    random: () => 0.5,
    baseOpenMs: 1_000,
    maxOpenMs: 8_000,
  });
  return { cb, advance: (ms: number) => (t += ms) };
}

describe('circuit breaker', () => {
  it('opens after five consecutive 5xx, probes half-open, closes on success', async () => {
    const { cb, advance } = setup();
    for (let i = 0; i < 4; i++) await cb.recordFailure('c', 'e', 500);
    expect((await cb.check('c', 'e')).allow).toBe(true);
    await cb.recordFailure('c', 'e', 502);
    const denied = await cb.check('c', 'e');
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.until.getTime()).toBeGreaterThan(1_000_000);
    advance(1_000); // base 1s → wait in [250, 1000] with random 0.5 = 625ms
    const probe = await cb.check('c', 'e');
    expect(probe).toMatchObject({ allow: true, probe: true, state: 'half_open' });
    expect((await cb.check('c', 'e')).allow).toBe(false); // second caller waits for the probe
    await cb.recordSuccess('c', 'e');
    expect(await cb.check('c', 'e')).toMatchObject({ allow: true, state: 'closed' });
  });

  it('backs off exponentially when the probe fails and caps the wait', async () => {
    const { cb, advance } = setup();
    for (let i = 0; i < 5; i++) await cb.recordFailure('c', 'e', 500);
    const first = await cb.state('c', 'e');
    const wait1 = first.until! - 1_000_000;
    advance(wait1);
    expect((await cb.check('c', 'e')).allow).toBe(true);
    await cb.recordFailure('c', 'e', 500); // probe failed → reopen with doubled ceiling
    const second = await cb.state('c', 'e');
    expect(second.state).toBe('open');
    expect(second.openCount).toBe(2);
    expect(second.until! - (1_000_000 + wait1)).toBeGreaterThan(wait1);
    for (let i = 0; i < 6; i++) {
      advance(60_000);
      await cb.check('c', 'e');
      await cb.recordFailure('c', 'e', 500);
    }
    const capped = await cb.state('c', 'e');
    expect(capped.until! - (await cb.state('c', 'e')).updatedAt).toBeLessThanOrEqual(8_000);
  });

  it('treats three 429s within a minute as a storm', async () => {
    const { cb, advance } = setup();
    await cb.recordFailure('c', 'e', 429);
    advance(70_000);
    await cb.recordFailure('c', 'e', 429);
    await cb.recordFailure('c', 'e', 429);
    expect((await cb.check('c', 'e')).allow).toBe(true); // only two inside the window
    await cb.recordFailure('c', 'e', 429);
    expect((await cb.check('c', 'e')).allow).toBe(false);
  });

  it('isolates endpoints and connections', async () => {
    const { cb } = setup();
    for (let i = 0; i < 5; i++) await cb.recordFailure('c', 'e', 500);
    expect((await cb.check('c', 'other')).allow).toBe(true);
    expect((await cb.check('c2', 'e')).allow).toBe(true);
  });
});
