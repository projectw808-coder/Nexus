import { describe, expect, it } from 'vitest';
import {
  FAILURE_CLASSES,
  FAILURE_TAXONOMY,
  NexusError,
  classifyHttpStatus,
  isRetryableHttpStatus,
} from './errors.ts';
import { attempt, err, ok, unwrap } from './result.ts';

describe('failure taxonomy', () => {
  it('has a spec entry for every class', () => {
    for (const code of FAILURE_CLASSES) {
      const spec = FAILURE_TAXONOMY[code];
      expect(spec.behaviour).toBeTypeOf('string');
      expect(spec.httpStatus).toBeGreaterThanOrEqual(200);
      expect(typeof spec.userMessage({})).toBe('string');
      expect(typeof spec.remediation({})).toBe('string');
    }
  });

  it('renders the §9.2 sentences with context', () => {
    const e = new NexusError('QUOTA_EXHAUSTED', {
      context: {
        platformName: 'YouTube',
        resetsAt: new Date('2026-09-25T07:00:00Z'),
        resetTimezone: 'PT',
      },
    });
    expect(e.userMessage).toBe('YouTube daily quota used. Resets 07:00 PT.');
    expect(e.behaviour).toBe('halt_until_reset');
    expect(e.retryable).toBe(true);
  });

  it('never retries a 4xx other than 408/429', () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
  });

  it('classifies bare statuses', () => {
    expect(classifyHttpStatus(401)).toBe('AUTH_EXPIRED');
    expect(classifyHttpStatus(403)).toBe('SCOPE_MISSING');
    expect(classifyHttpStatus(429)).toBe('RATE_LIMITED');
    expect(classifyHttpStatus(503)).toBe('PLATFORM_DOWN');
  });

  it('serialises without stack or cause', () => {
    const e = new NexusError('SCOPE_MISSING', {
      context: {
        scope: 'instagram_manage_comments',
        capability: 'Comment replies',
        platformName: 'Instagram',
      },
      details: { endpoint: '/comments' },
      cause: new Error('secret internals'),
    });
    const json = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    expect(json).not.toHaveProperty('stack');
    expect(json).not.toHaveProperty('cause');
    expect(json['code']).toBe('SCOPE_MISSING');
    expect(json['remediation']).toContain('instagram_manage_comments');
  });

  it('NexusError.from keeps an existing classification', () => {
    const original = new NexusError('RATE_LIMITED');
    expect(NexusError.from(original)).toBe(original);
    expect(NexusError.from(new Error('boom')).code).toBe('INTERNAL');
  });
});

describe('Result', () => {
  it('attempt captures throws', async () => {
    const r = await attempt(
      () => {
        throw new Error('x');
      },
      (e) => NexusError.from(e),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INTERNAL');
  });

  it('unwrap returns value or throws error', () => {
    expect(unwrap(ok(1))).toBe(1);
    expect(() => unwrap(err(new Error('nope')))).toThrow('nope');
  });
});
