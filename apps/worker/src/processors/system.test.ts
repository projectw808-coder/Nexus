import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { handleSystemJob, type SystemJobData } from './system.ts';

const fakeLog = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof handleSystemJob>[1];

const jobOf = (name: string, data: SystemJobData): Job<SystemJobData> =>
  ({ name, data, id: '1', attemptsMade: 0 }) as unknown as Job<SystemJobData>;

describe('system queue', () => {
  it('ping returns pong with queue latency', async () => {
    const sentAt = new Date(Date.now() - 50).toISOString();
    const out = await handleSystemJob(jobOf('ping', { sentAt }), fakeLog);
    expect('pong' in out && out.pong).toBe(true);
    expect('queueLatencyMs' in out ? out.queueLatencyMs : 0).toBeGreaterThanOrEqual(50);
  });

  it('rejects unknown job names', async () => {
    await expect(handleSystemJob(jobOf('nope', {}), fakeLog)).rejects.toThrow('unknown system job');
  });
});
