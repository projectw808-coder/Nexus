# Outbound webhooks

Nexus POSTs a signed JSON body to your endpoint when something happens in a workspace
(spec §11.2, ADR-022 decision 4). Configure endpoints in **Settings → Webhooks**; owners and
admins only.

## Subscribing

An endpoint is an `https` URL plus the list of event names you want. Creating one mints a signing
secret and shows it **once** — Nexus stores it encrypted in the TokenVault and can never show it
to you again. Lost it? Rotate the secret, which invalidates the old one immediately.

## Events

The public event names are a stable contract, and are not identical to Nexus's internal trigger
vocabulary — the conversation-shaped ones are namespaced.

| Public event name               | Internal `AutomationEvent.type` | Fires when                                  |
| ------------------------------- | ------------------------------- | ------------------------------------------- |
| `record.created`                | `record.created`                | A record is created (any object type)       |
| `record.updated`                | `record.updated`                | One or more attributes of a record change   |
| `list.entry_added`              | `list.entry_added`              | A record is added to a list or pipeline     |
| `list.stage_changed`            | `list.stage_changed`            | A pipeline entry moves to a different stage |
| `conversation.message.received` | `message.received`              | An inbound DM or email arrives              |
| `conversation.comment.received` | `comment.received`              | An inbound comment arrives                  |
| `conversation.mention.received` | `mention.received`              | The account is mentioned                    |
| `lead_form.submitted`           | `lead_form.submitted`           | A lead form is submitted                    |

Internal triggers that are deliberately **not** published: `schedule`, `webhook.inbound`,
`sla.breach_imminent`, `task.overdue`, `ai.insight_produced`. The mapping is a single exhaustive
table (`PUBLIC_EVENT_FOR_TRIGGER` in `packages/sync/src/outbound-webhooks.ts`), so a new internal
trigger cannot be added without deciding whether customers see it.

## The request

```
POST https://your-endpoint.example.com/hooks/nexus
Content-Type: application/json
User-Agent: Nexus-Webhooks/1
X-Nexus-Signature: t=1790000000,v1=6f1c…<64 hex chars>
X-Nexus-Event: record.created
X-Nexus-Delivery: 2f2e9c1e-…            # the delivery id — your idempotency key
X-Nexus-Attempt: 1                       # 1-based attempt number of this POST
X-Nexus-Subscription: 8b0a…              # which of your endpoints this is
```

```json
{
  "id": "2f2e9c1e-…",
  "event": "record.created",
  "createdAt": "2026-09-26T10:00:00.000Z",
  "workspaceId": "…",
  "data": {
    "occurredAt": "2026-09-26T10:00:00.000Z",
    "recordId": "…",
    "objectTypeApiSlug": "person",
    "values": { "name": "Ada Lovelace" }
  }
}
```

`data` is flat: the identifying ids that apply to the event (`recordId`, `objectTypeApiSlug`,
`listId`, `entryId`, `conversationId`, `identityId`, `connectionId`, `platform`,
`timelineEventId`), then the event's own payload. Absent ids are omitted, not sent as `null`.

## Verifying the signature

`X-Nexus-Signature` is `t=<unix seconds>,v1=<hex>`, where `<hex>` is
`HMAC-SHA256(secret, "${t}.${rawBody}")` — the same scheme Stripe and GitHub use. Sign the **raw
request body**, before any JSON parsing or re-serialization, and compare in constant time. The
timestamp is inside the signed material, so it cannot be moved without breaking the signature;
reject anything older than about five minutes to bound replays.

```js
const crypto = require('node:crypto');

function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
}
```

Nexus's own implementation of both sides is `packages/db/src/webhooks/signing.ts`
(`signPayload`, `verifySignature`, `verifySignatureHeader`) — the snippet above is that format,
and the test suite proves the two agree.

## Delivery, retries and replay

- Respond with any `2xx` within a few seconds. Nexus times a request out after 5s; do the real
  work asynchronously and acknowledge immediately.
- A `408`, `429` or `5xx`, a timeout or a transport error is retried with the platform-wide
  policy — exponential backoff with full jitter, six attempts total — after which the delivery is
  marked `DEAD_LETTERED`. A `Retry-After` on a `429` is honoured when it is longer than the
  computed backoff.
- Any other `4xx` is treated as "you meant to reject this" and is **not** retried.
- Responses are recorded on the delivery (status plus the first 2 KB of the body) and shown in the
  delivery log under each endpoint.
- **Deliveries are idempotent by id, not by content.** The same underlying event can never produce
  two delivery rows for the same endpoint (`@@unique([workspaceId, subscriptionId,
idempotencyKey])`), but a retry re-sends the same `X-Nexus-Delivery` id — deduplicate on it.
- Anyone with admin access can **replay** a delivered or dead-lettered delivery from the log. The
  delivery row is reset in place and re-sent with the same `id` and body, exactly like the inbound
  webhook replay elsewhere in the product.

## Pausing and deleting

Pausing an endpoint stops new deliveries being created and dead-letters anything already queued for
it. Deleting one is a soft delete: the endpoint disappears, its delivery history stays for audit,
and its signing secret is revoked so the vault holds nothing recoverable.
