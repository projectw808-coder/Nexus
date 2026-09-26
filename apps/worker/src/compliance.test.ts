/**
 * The compliance host's job-name routing (§5.5). The work itself is tested against a real
 * database in `packages/db/src/compliance/compliance.test.ts`; what matters here is that the
 * `system` worker reaches these jobs by name and validates a DSAR job's payload before doing
 * anything irreversible with it.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMPLIANCE_JOB_NAMES, COMPLIANCE_SYSTEM_JOBS, handleComplianceJob } from './compliance.ts';

const fakeLog = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof handleComplianceJob>[2];

describe('compliance jobs', () => {
  it('claims exactly the job names it handles', () => {
    expect([...COMPLIANCE_JOB_NAMES].sort()).toEqual(['dsr.process', 'retention.purge']);
    // Must not collide with the housekeeping names the base system processor owns.
    for (const name of ['ping', 'index.build', 'index.drop', 'attribute.purge']) {
      expect(COMPLIANCE_JOB_NAMES.has(name)).toBe(false);
    }
  });

  it('rejects an unknown job name', async () => {
    await expect(handleComplianceJob('nope', {}, fakeLog)).rejects.toThrow(
      'unknown compliance job',
    );
  });

  it('refuses a DSAR job without a workspace and request id, before touching the database', async () => {
    await expect(handleComplianceJob(COMPLIANCE_SYSTEM_JOBS.dsr, {}, fakeLog)).rejects.toThrow();
    await expect(
      handleComplianceJob(COMPLIANCE_SYSTEM_JOBS.dsr, { workspaceId: 'w1' }, fakeLog),
    ).rejects.toThrow();
  });
});
