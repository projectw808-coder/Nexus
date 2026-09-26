import { router, userProcedure } from '../trpc';
import { aiRouter } from './ai';
import { apiKeyRouter } from './api-keys';
import { auditRouter } from './audit';
import { cannedReplyRouter } from './canned-replies';
import { complianceNoteRouter, dataSubjectRequestRouter } from './compliance';
import { consentRouter } from './consent';
import { connectionGrantRouter } from './connection-grants';
import { connectionRouter } from './connections';
import { conversationRouter } from './conversations';
import { exportRouter } from './export';
import { fieldMappingRouter } from './field-mappings';
import { healthRouter } from './health';
import { identityRouter } from './identities';
import { mergeSuggestionRouter } from './merge-suggestions';
import { timelineRouter } from './timeline';
import { importRouter } from './imports';
import { invitationRouter } from './invitation';
import { listEntryRouter, listRouter } from './lists';
import { memberRouter } from './member';
import { noteRouter } from './notes';
import { outboundWebhookRouter } from './outbound-webhooks';
import { attributeRouter, objectTypeRouter } from './objects';
import { companyRouter, dealRouter, personRouter, recordRouter } from './records';
// Phase 11 — Reports (§12.2.E). One clearly separated block; this file is hand-merged.
import { dashboardRouter, widgetRouter } from './reports';
import { searchRouter } from './search';
import { taskRouter } from './tasks';
import { viewRouter } from './views';
import { webhookEventRouter } from './webhook-events';
import { workflowRouter } from './workflows';
import { workspaceRouter } from './workspace';

export const appRouter = router({
  me: router({
    get: userProcedure.query(({ ctx }) => ctx.session),
  }),
  workspace: workspaceRouter,
  member: memberRouter,
  invitation: invitationRouter,
  audit: auditRouter,
  // Phase 2 — the object graph
  objectType: objectTypeRouter,
  attribute: attributeRouter,
  record: recordRouter,
  person: personRouter,
  company: companyRouter,
  deal: dealRouter,
  list: listRouter,
  listEntry: listEntryRouter,
  view: viewRouter,
  search: searchRouter,
  import: importRouter,
  export: exportRouter,
  note: noteRouter,
  task: taskRouter,
  // Phase 4 — connector runtime
  connection: connectionRouter,
  // Phase 5 — conversations (bare inbox)
  conversation: conversationRouter,
  // Phase 6 — identity resolution and the unified timeline
  identity: identityRouter,
  mergeSuggestion: mergeSuggestionRouter,
  timeline: timelineRouter,
  // Phase 7 — the unified inbox
  cannedReply: cannedReplyRouter,
  // Phase 9 — the integrations hub & health console
  connectionGrant: connectionGrantRouter,
  webhookEvent: webhookEventRouter,
  fieldMapping: fieldMappingRouter,
  health: healthRouter,
  // Phase 10 — automation + AI
  workflow: workflowRouter,
  ai: aiRouter,
  // Phase 11 — the compliance layer (§5.5, ADR-022)
  consent: consentRouter,
  dataSubjectRequest: dataSubjectRequestRouter,
  complianceNote: complianceNoteRouter,
  // Phase 11 — the public REST API's credentials (ADR-022)
  apiKey: apiKeyRouter,
  // Phase 11 — customer-facing outbound webhooks (§11.2)
  outboundWebhook: outboundWebhookRouter,
  // Phase 11 — Reports
  dashboard: dashboardRouter,
  widget: widgetRouter,
});

export type AppRouter = typeof appRouter;
