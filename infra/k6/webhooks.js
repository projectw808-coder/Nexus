/**
 * Load test (spec §15, §2): 10,000 webhooks/minute ingest, asserting the ack path (verify
 * signature → persist WebhookEvent → enqueue → 200) stays under the p99 < 200 ms budget with
 * ingest fully decoupled from processing — the handler never runs connector/normalize logic
 * inline (§11.3 "no business logic in the handler, ever").
 *
 * Run against a server started the same way apps/web/e2e's Playwright config starts one
 * (`node apps/web/e2e/server.cjs`, E2E_AUTH_BYPASS=true — see .github/workflows/ci.yml), with a
 * Mock connection already seeded so CONNECTION_ID/WEBHOOK_SECRET are real. Usage:
 *
 *   k6 run -e BASE_URL=http://localhost:3200 \
 *          -e CONNECTION_ID=<uuid> \
 *          -e WEBHOOK_SECRET=<the connection's mock webhook secret> \
 *          infra/k6/webhooks.js
 *
 * 10,000/minute ≈ 167/second; `rate` below targets that with headroom to see the p99 clearly
 * before it's saturated.
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3200';
const CONNECTION_ID = __ENV.CONNECTION_ID || '';
const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || 'mock-webhook-secret';

const ackFailures = new Rate('ack_failures');
const ackDuration = new Trend('ack_duration_ms', true);

export const options = {
  scenarios: {
    ingest: {
      executor: 'constant-arrival-rate',
      rate: 180, // per-second target, comfortably above the 10k/min (~167/s) budget
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // §2: "Webhook ingest ack: p99 < 200 ms (ack first, process async — always)."
    ack_duration_ms: ['p(99)<200'],
    ack_failures: ['rate<0.01'],
  },
};

function hmacSha256Hex(body, secret) {
  return `sha256=${crypto.hmac('sha256', secret, body, 'hex')}`;
}

export default function () {
  const body = JSON.stringify({
    entry: [
      {
        id: 'demo_mock_1',
        changes: [
          { field: 'comments', value: { id: `k6_${__VU}_${__ITER}`, text: 'load test comment' } },
        ],
      },
    ],
  });
  const signature = hmacSha256Hex(body, WEBHOOK_SECRET);
  const path = CONNECTION_ID ? `/api/webhooks/mock/${CONNECTION_ID}` : '/api/webhooks/mock';

  const res = http.post(`${BASE_URL}${path}`, body, {
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature },
  });

  ackDuration.add(res.timings.duration);
  const ok = check(res, {
    'ack is 200': (r) => r.status === 200,
    'ack under 200ms': (r) => r.timings.duration < 200,
  });
  ackFailures.add(!ok);
}
