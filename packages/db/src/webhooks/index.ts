/**
 * Customer-facing outbound webhooks (§11.2, ADR-022 decision 4): subscriptions, the HMAC signing
 * format, the delivery log and one signed POST attempt. The queue wiring lives in `@nexus/sync`
 * (`dispatchOutboundWebhooks`, `deliverOutboundWebhookJob`) and `apps/worker`.
 */
export {
  OUTBOUND_EVENT_TYPES,
  OUTBOUND_EVENT_DESCRIPTION,
  isOutboundEventType,
  assertOutboundEventTypes,
  outboundIdempotencyKeyFor,
  dispatchOutboundWebhookEvent,
} from './events.ts';
export type {
  OutboundEventType,
  OutboundWebhookEvent,
  OutboundWebhookEnqueue,
  PendingOutboundDelivery,
  DispatchResult,
} from './events.ts';
export {
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
  ATTEMPT_HEADER,
  SUBSCRIPTION_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
  SECRET_PREFIX,
  generateSigningSecret,
  signPayload,
  signatureHeaderValue,
  parseSignatureHeader,
  verifySignature,
  verifySignatureHeader,
} from './signing.ts';
export type { ParsedSignatureHeader } from './signing.ts';
export {
  assertDeliverableUrl,
  createSubscription,
  listSubscriptions,
  getSubscription,
  updateSubscription,
  deleteSubscription,
  rotateSubscriptionSecret,
} from './subscriptions.ts';
export type {
  SubscriptionRow,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
} from './subscriptions.ts';
export {
  RESPONSE_BODY_LIMIT,
  DEFAULT_TIMEOUT_MS,
  runOutboundWebhookDelivery,
  listDeliveries,
  getDelivery,
  deliveryCounts,
  replayDelivery,
  sweepDueOutboundDeliveries,
} from './deliveries.ts';
export type {
  OutboundWebhookBody,
  DeliveryDeps,
  DeliveryOutcome,
  DeliveryRow,
} from './deliveries.ts';
