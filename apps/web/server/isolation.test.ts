/**
 * Phase 1 acceptance, generated from the router manifest so a new route cannot be forgotten:
 *
 *  1. Cross-tenant isolation: a user who is not a member of workspace A gets NOT_FOUND on every
 *     tenant procedure addressed to A, and a member of B addressing B with A's ids gets
 *     NOT_FOUND — never A's data.
 *  2. A `viewer` cannot mutate anything.
 *  3. Every mutation writes an audit row.
 *
 * Every procedure must have an entry in FIXTURES; the first test fails otherwise.
 */
import { toCsv } from '@nexus/core';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  linkIdentity,
  mergeRecords,
  recordDeadLetter,
  recordIntegrationError,
  upsertConnection,
  upsertIdentity,
} from '@nexus/db';
import { NexusError } from '@nexus/core';
import { callPath, procedureManifest, seedWorkspaces, type Seed } from './testing';

type Tier = 'public' | 'user' | 'tenant';
type Fixture = {
  tier: Tier;
  /** Valid input for the owner of Acme; `ids` are Acme's rows, refreshed before each call. */
  input: (ids: Ids) => unknown;
  /** Input that references Acme rows but is sent to Globex (cross-tenant by id). */
  crossInput?: (ids: Ids) => unknown;
  /** Reason a user-tier mutation writes its audit row inside packages/db instead of ctx.audit. */
  auditedBy?: 'tenancy';
  /** Expected code for a member of B using A's ids (default NOT_FOUND). */
  crossExpect?: string;
};

type Ids = {
  carolMembershipId: string;
  invitationId: string;
  auditCursor: string | undefined;
  objectTypeId: string;
  attributeId: string;
  recordId: string;
  listId: string;
  entryId: string;
  viewId: string;
  importJobId: string;
  spareRecordId: string;
  noteId: string;
  taskId: string;
  personId: string;
  companyId: string;
  dealId: string;
  connectionId: string;
  connectionLabel: string;
  integrationErrorId: string;
  deadLetterId: string;
  conversationId: string;
  // Phase 6
  identityId: string;
  unresolvedIdentityId: string;
  suggestionId: string;
  mergeId: string;
  person2Id: string;
  company2Id: string;
  deal2Id: string;
  // Phase 7
  cannedReplyId: string;
};

const FIXTURES: Record<string, Fixture> = {
  'me.get': { tier: 'user', input: () => undefined },
  'workspace.list': { tier: 'user', input: () => undefined },
  'workspace.create': {
    tier: 'user',
    input: () => ({ name: 'Initech', slug: `initech-${Date.now()}` }),
    auditedBy: 'tenancy',
  },
  'workspace.current': { tier: 'tenant', input: () => undefined },
  'workspace.update': { tier: 'tenant', input: () => ({ name: 'Acme Corp' }) },
  'member.list': { tier: 'tenant', input: () => undefined },
  'member.changeRole': {
    tier: 'tenant',
    input: (ids) => ({ membershipId: ids.carolMembershipId, role: 'MEMBER' }),
    crossInput: (ids) => ({ membershipId: ids.carolMembershipId, role: 'MEMBER' }),
  },
  'member.remove': {
    tier: 'tenant',
    input: (ids) => ({ membershipId: ids.carolMembershipId }),
    crossInput: (ids) => ({ membershipId: ids.carolMembershipId }),
  },
  'invitation.list': { tier: 'tenant', input: () => undefined },
  'invitation.create': {
    tier: 'tenant',
    input: () => ({ email: `new-${Date.now()}@acme.test`, role: 'MEMBER' }),
  },
  'invitation.revoke': {
    tier: 'tenant',
    input: (ids) => ({ invitationId: ids.invitationId }),
    crossInput: (ids) => ({ invitationId: ids.invitationId }),
  },
  'invitation.preview': { tier: 'public', input: () => ({ token: 'x'.repeat(32) }) },
  'invitation.accept': {
    tier: 'user',
    input: () => ({ token: 'x'.repeat(32) }),
    auditedBy: 'tenancy',
  },
  'audit.list': { tier: 'tenant', input: (ids) => ({ limit: 10, cursor: ids.auditCursor }) },
  // ── Phase 2 ─────────────────────────────────────────────────────────────
  'objectType.list': { tier: 'tenant', input: () => undefined },
  'objectType.get': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId }),
  },
  'objectType.create': {
    tier: 'tenant',
    input: () => ({ apiSlug: `obj_${Date.now()}`, singular: 'Thing', plural: 'Things' }),
  },
  'objectType.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.objectTypeId, singular: 'Widget!' }),
    crossInput: (ids) => ({ id: ids.objectTypeId, singular: 'Pwned' }),
  },
  'objectType.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.objectTypeId }),
    crossInput: (ids) => ({ id: ids.objectTypeId }),
  },
  'attribute.list': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId }),
  },
  'attribute.migrationPreview': {
    tier: 'tenant',
    input: (ids) => ({ objectTypeId: ids.objectTypeId, type: 'TEXT' }),
  },
  'attribute.create': {
    tier: 'tenant',
    input: (ids) => ({
      objectTypeId: ids.objectTypeId,
      apiSlug: `a_${Date.now()}`,
      title: 'A',
      type: 'TEXT',
    }),
    crossInput: (ids) => ({
      objectTypeId: ids.objectTypeId,
      apiSlug: 'pwned',
      title: 'P',
      type: 'TEXT',
    }),
  },
  'attribute.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId, title: 'Renamed' }),
    crossInput: (ids) => ({ id: ids.attributeId, title: 'Pwned' }),
  },
  'attribute.setIndexed': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId, indexed: true }),
    crossInput: (ids) => ({ id: ids.attributeId, indexed: true }),
  },
  'attribute.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId }),
    crossInput: (ids) => ({ id: ids.attributeId }),
  },
  'attribute.restore': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.attributeId }),
    crossInput: (ids) => ({ id: ids.attributeId }),
  },
  'attribute.reorder': {
    tier: 'tenant',
    input: (ids) => ({ objectTypeId: ids.objectTypeId, ids: [ids.attributeId] }),
  },
  'attribute.setPermission': {
    tier: 'tenant',
    input: (ids) => ({ attributeId: ids.attributeId, role: 'MEMBER', access: 'READ' }),
    crossInput: (ids) => ({ attributeId: ids.attributeId, role: 'MEMBER', access: 'HIDDEN' }),
  },
  'record.query': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId }),
  },
  'record.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.recordId }),
    crossInput: (ids) => ({ id: ids.recordId }),
  },
  'record.create': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget', values: { name: 'New' } }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId, values: { name: 'Pwned' } }),
  },
  'record.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.recordId, values: { name: 'Updated' } }),
    crossInput: (ids) => ({ id: ids.recordId, values: { name: 'Pwned' } }),
  },
  'record.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.recordId] }) },
  'record.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.recordId] }) },
  'person.query': { tier: 'tenant', input: () => ({}) },
  'person.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.personId }),
    crossInput: (ids) => ({ id: ids.personId }),
  },
  'person.create': { tier: 'tenant', input: () => ({ values: { name: 'Pat' } }) },
  'person.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.personId, values: { name: 'x' } }),
    crossInput: (ids) => ({ id: ids.personId, values: { name: 'Pwned' } }),
  },
  'person.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.personId] }) },
  'person.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.personId] }) },
  'company.query': { tier: 'tenant', input: () => ({}) },
  'company.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.companyId }),
    crossInput: (ids) => ({ id: ids.companyId }),
  },
  'company.create': { tier: 'tenant', input: () => ({ values: { name: 'Co' } }) },
  'company.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.companyId, values: { name: 'x' } }),
    crossInput: (ids) => ({ id: ids.companyId, values: { name: 'Pwned' } }),
  },
  'company.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.companyId] }) },
  'company.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.companyId] }) },
  'deal.query': { tier: 'tenant', input: () => ({}) },
  'deal.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.dealId }),
    crossInput: (ids) => ({ id: ids.dealId }),
  },
  'deal.create': { tier: 'tenant', input: () => ({ values: { name: 'D' } }) },
  'deal.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.dealId, values: { name: 'x' } }),
    crossInput: (ids) => ({ id: ids.dealId, values: { name: 'Pwned' } }),
  },
  'deal.delete': { tier: 'tenant', input: (ids) => ({ ids: [ids.dealId] }) },
  'deal.restore': { tier: 'tenant', input: (ids) => ({ ids: [ids.dealId] }) },
  'list.list': { tier: 'tenant', input: () => ({}) },
  'list.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.listId }),
    crossInput: (ids) => ({ id: ids.listId }),
  },
  'list.create': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget', name: 'L', kind: 'COLLECTION' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId, name: 'Pwned', kind: 'COLLECTION' }),
  },
  'list.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.listId, name: 'L2' }),
    crossInput: (ids) => ({ id: ids.listId, name: 'Pwned' }),
  },
  'list.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.listId }),
    crossInput: (ids) => ({ id: ids.listId }),
  },
  'listEntry.add': {
    tier: 'tenant',
    input: (ids) => ({ listId: ids.listId, recordId: ids.spareRecordId }),
    crossInput: (ids) => ({ listId: ids.listId, recordId: ids.spareRecordId }),
  },
  'listEntry.move': {
    tier: 'tenant',
    input: (ids) => ({ entryId: ids.entryId, stage: 's2' }),
    crossInput: (ids) => ({ entryId: ids.entryId, stage: 's2' }),
  },
  'listEntry.update': {
    tier: 'tenant',
    input: (ids) => ({ entryId: ids.entryId, values: {} }),
    crossInput: (ids) => ({ entryId: ids.entryId, values: {} }),
  },
  'listEntry.remove': {
    tier: 'tenant',
    input: (ids) => ({ entryId: ids.entryId }),
    crossInput: (ids) => ({ entryId: ids.entryId }),
  },
  'listEntry.history': { tier: 'tenant', input: (ids) => ({ entryId: ids.entryId }) },
  'view.list': { tier: 'tenant', input: () => ({}) },
  'view.create': {
    tier: 'tenant',
    input: (ids) => ({ objectTypeId: ids.objectTypeId, name: 'V' }),
  },
  'view.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.viewId, name: 'V2' }),
    crossInput: (ids) => ({ id: ids.viewId, name: 'Pwned' }),
  },
  'view.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.viewId }),
    crossInput: (ids) => ({ id: ids.viewId }),
  },
  'search.global': { tier: 'tenant', input: () => ({ q: 'widget' }) },
  'import.list': { tier: 'tenant', input: () => ({}) },
  'import.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
  },
  'import.create': {
    tier: 'tenant',
    input: () => ({
      objectType: 'widget',
      fileName: 'w.csv',
      csvText: toCsv(['name'], [['a'], ['b']]),
    }),
    crossInput: (ids) => ({
      objectType: ids.objectTypeId,
      fileName: 'p.csv',
      csvText: 'name\npwned\n',
    }),
  },
  'import.preview': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
  },
  'import.run': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
  },
  'import.rollback': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.importJobId }),
    crossInput: (ids) => ({ id: ids.importJobId }),
    crossExpect: 'NOT_FOUND',
  },
  'record.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.recordId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.recordId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'record.history': { tier: 'tenant', input: (ids) => ({ id: ids.recordId }) },
  'listEntry.addMany': {
    tier: 'tenant',
    input: (ids) => ({ listId: ids.listId, recordIds: [ids.spareRecordId] }),
    crossInput: (ids) => ({ listId: ids.listId, recordIds: [ids.spareRecordId] }),
  },
  'note.list': { tier: 'tenant', input: (ids) => ({ recordId: ids.recordId }) },
  'note.create': {
    tier: 'tenant',
    input: (ids) => ({ recordId: ids.recordId, body: 'hello' }),
    crossInput: (ids) => ({ recordId: ids.recordId, body: 'pwned' }),
  },
  'note.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.noteId, pinned: true }),
    crossInput: (ids) => ({ id: ids.noteId, body: 'pwned' }),
  },
  'note.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.noteId }),
    crossInput: (ids) => ({ id: ids.noteId }),
  },
  'task.list': { tier: 'tenant', input: (ids) => ({ recordId: ids.recordId }) },
  'task.create': {
    tier: 'tenant',
    input: (ids) => ({ recordId: ids.recordId, title: 'Call' }),
    crossInput: (ids) => ({ recordId: ids.recordId, title: 'pwned' }),
  },
  'task.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.taskId, status: 'DONE' }),
    crossInput: (ids) => ({ id: ids.taskId, title: 'pwned' }),
  },
  'task.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.taskId }),
    crossInput: (ids) => ({ id: ids.taskId }),
  },
  'person.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.personId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.personId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'person.history': { tier: 'tenant', input: (ids) => ({ id: ids.personId }) },
  'company.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.companyId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.companyId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'company.history': { tier: 'tenant', input: (ids) => ({ id: ids.companyId }) },
  'deal.bulkUpdate': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.dealId], values: { name: 'Bulk' } }),
    crossInput: (ids) => ({ ids: [ids.dealId], values: { name: 'Pwned' } }),
    crossExpect: 'ok',
  },
  'deal.history': { tier: 'tenant', input: (ids) => ({ id: ids.dealId }) },
  'export.records': {
    tier: 'tenant',
    input: () => ({ objectType: 'widget', format: 'csv' }),
    crossInput: (ids) => ({ objectType: ids.objectTypeId, format: 'csv' }),
  },
  // Phase 4 — connections
  'connection.list': { tier: 'tenant', input: () => undefined },
  'connection.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId }),
    crossInput: (ids) => ({ id: ids.connectionId }),
  },
  'connection.connectUrl': { tier: 'tenant', input: () => ({ platform: 'MOCK' }) },
  'connection.connectApiKey': {
    tier: 'tenant',
    input: () => ({
      platform: 'KEITARO',
      apiKey: 'test-keitaro-key',
      baseUrl: 'https://tracker.acme.test',
    }),
  },
  'connection.updateSettings': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId, settings: { backfillDays: 30 } }),
    crossInput: (ids) => ({ id: ids.connectionId, settings: { paused: true } }),
  },
  'connection.pause': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId }),
    crossInput: (ids) => ({ id: ids.connectionId }),
  },
  'connection.resume': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId }),
    crossInput: (ids) => ({ id: ids.connectionId }),
  },
  'connection.syncNow': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId }),
    crossInput: (ids) => ({ id: ids.connectionId }),
  },
  'connection.runs': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId }),
    crossInput: (ids) => ({ id: ids.connectionId }),
  },
  'connection.errors': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId }),
    crossInput: (ids) => ({ id: ids.connectionId }),
  },
  'connection.resolveError': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.integrationErrorId }),
    crossInput: (ids) => ({ id: ids.integrationErrorId }),
  },
  'connection.deadLetters': { tier: 'tenant', input: () => undefined },
  'connection.replayDeadLetter': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.deadLetterId }),
    crossInput: (ids) => ({ id: ids.deadLetterId }),
  },
  // Phase 5 — conversations
  'conversation.list': { tier: 'tenant', input: () => undefined },
  'conversation.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId }),
    crossInput: (ids) => ({ id: ids.conversationId }),
  },
  'conversation.reply': {
    tier: 'tenant',
    input: (ids) => ({
      id: ids.conversationId,
      text: 'thanks!',
      requestNonce: `n-${Date.now()}-${Math.random()}`,
    }),
    crossInput: (ids) => ({ id: ids.conversationId, text: 'pwned', requestNonce: 'nonce-cross-1' }),
  },
  'conversation.setStatus': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId, status: 'CLOSED' }),
    crossInput: (ids) => ({ id: ids.conversationId, status: 'SPAM' }),
  },
  'conversation.markRead': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId }),
    crossInput: (ids) => ({ id: ids.conversationId }),
  },
  // Phase 6 — identity resolution and the unified timeline
  'timeline.list': {
    tier: 'tenant',
    input: (ids) => ({ recordId: ids.personId }),
    crossInput: (ids) => ({ recordId: ids.personId }),
  },
  'identity.list': { tier: 'tenant', input: () => ({ unresolved: true }) },
  'identity.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.identityId }),
    crossInput: (ids) => ({ id: ids.identityId }),
  },
  'identity.candidates': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.unresolvedIdentityId }),
    crossInput: (ids) => ({ id: ids.unresolvedIdentityId }),
  },
  'identity.link': {
    tier: 'tenant',
    input: (ids) => ({ identityId: ids.unresolvedIdentityId, personRecordId: ids.personId }),
    crossInput: (ids) => ({ identityId: ids.unresolvedIdentityId, personRecordId: ids.personId }),
  },
  'identity.unlink': {
    tier: 'tenant',
    input: (ids) => ({ identityId: ids.identityId }),
    crossInput: (ids) => ({ identityId: ids.identityId }),
  },
  'identity.createPerson': {
    tier: 'tenant',
    input: (ids) => ({ identityId: ids.unresolvedIdentityId }),
    crossInput: (ids) => ({ identityId: ids.unresolvedIdentityId }),
  },
  'identity.resolve': {
    tier: 'tenant',
    input: (ids) => ({ identityId: ids.unresolvedIdentityId }),
    crossInput: (ids) => ({ identityId: ids.unresolvedIdentityId }),
  },
  'mergeSuggestion.list': { tier: 'tenant', input: () => undefined },
  'mergeSuggestion.get': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.suggestionId }),
    crossInput: (ids) => ({ id: ids.suggestionId }),
  },
  'mergeSuggestion.accept': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.suggestionId }),
    crossInput: (ids) => ({ id: ids.suggestionId }),
  },
  'mergeSuggestion.reject': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.suggestionId, reason: 'different people' }),
    crossInput: (ids) => ({ id: ids.suggestionId }),
  },
  'mergeSuggestion.rescore': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.suggestionId }),
    crossInput: (ids) => ({ id: ids.suggestionId }),
  },
  'record.merge': {
    tier: 'tenant',
    input: (ids) => ({ winnerId: ids.recordId, loserId: ids.spareRecordId }),
    crossInput: (ids) => ({ winnerId: ids.recordId, loserId: ids.spareRecordId }),
  },
  'record.unmerge': {
    tier: 'tenant',
    input: (ids) => ({ mergeId: ids.mergeId }),
    crossInput: (ids) => ({ mergeId: ids.mergeId }),
  },
  'person.merge': {
    tier: 'tenant',
    input: (ids) => ({ winnerId: ids.personId, loserId: ids.person2Id }),
    crossInput: (ids) => ({ winnerId: ids.personId, loserId: ids.person2Id }),
  },
  'person.unmerge': {
    tier: 'tenant',
    input: (ids) => ({ mergeId: ids.mergeId }),
    crossInput: (ids) => ({ mergeId: ids.mergeId }),
  },
  'company.merge': {
    tier: 'tenant',
    input: (ids) => ({ winnerId: ids.companyId, loserId: ids.company2Id }),
    crossInput: (ids) => ({ winnerId: ids.companyId, loserId: ids.company2Id }),
  },
  'company.unmerge': {
    tier: 'tenant',
    input: (ids) => ({ mergeId: ids.mergeId }),
    crossInput: (ids) => ({ mergeId: ids.mergeId }),
  },
  'deal.merge': {
    tier: 'tenant',
    input: (ids) => ({ winnerId: ids.dealId, loserId: ids.deal2Id }),
    crossInput: (ids) => ({ winnerId: ids.dealId, loserId: ids.deal2Id }),
  },
  'deal.unmerge': {
    tier: 'tenant',
    input: (ids) => ({ mergeId: ids.mergeId }),
    crossInput: (ids) => ({ mergeId: ids.mergeId }),
  },
  // Phase 7 — the unified inbox
  'conversation.context': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId }),
    crossInput: (ids) => ({ id: ids.conversationId }),
  },
  'conversation.assign': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId, userId: null }),
    crossInput: (ids) => ({ id: ids.conversationId, userId: null }),
  },
  'conversation.snooze': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId, until: new Date(Date.now() + 3600_000) }),
    crossInput: (ids) => ({ id: ids.conversationId, until: new Date(Date.now() + 3600_000) }),
  },
  'conversation.setTags': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.conversationId, tags: ['vip'] }),
    crossInput: (ids) => ({ id: ids.conversationId, tags: ['pwned'] }),
  },
  'conversation.bulk': {
    tier: 'tenant',
    input: (ids) => ({ ids: [ids.conversationId], action: { type: 'read' } }),
    crossInput: (ids) => ({
      ids: [ids.conversationId],
      action: { type: 'status', status: 'SPAM' },
    }),
    crossExpect: 'ok',
  },
  'cannedReply.list': { tier: 'tenant', input: () => undefined },
  'cannedReply.create': {
    tier: 'tenant',
    input: () => ({ title: `Thanks ${Date.now()}`, body: 'Thanks for reaching out!' }),
  },
  'cannedReply.update': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.cannedReplyId, body: 'Updated body' }),
    crossInput: (ids) => ({ id: ids.cannedReplyId, body: 'Pwned' }),
  },
  'cannedReply.delete': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.cannedReplyId }),
    crossInput: (ids) => ({ id: ids.cannedReplyId }),
  },
  'connection.disconnect': {
    tier: 'tenant',
    input: (ids) => ({ id: ids.connectionId, confirmLabel: ids.connectionLabel }),
    crossInput: (ids) => ({ id: ids.connectionId, confirmLabel: ids.connectionLabel }),
  },
};

let seed: Seed;
let widgetTypeId: string;

async function freshIds(): Promise<Ids> {
  // Re-seed the rows mutations consume so each test starts from a known state.
  const carol = await seed.db.runtime.withSystem(async (s) => {
    const m = await s.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: seed.acme.id, userId: seed.users.carol.id } },
    });
    return m
      ? s.membership.update({ where: { id: m.id }, data: { deletedAt: null, role: 'VIEWER' } })
      : s.membership.create({
          data: { workspaceId: seed.acme.id, userId: seed.users.carol.id, role: 'VIEWER' },
        });
  });
  const owner = seed.caller(seed.users.alice, 'acme');
  const inv = await owner.invitation.create({
    email: `pending-${Date.now()}-${Math.random()}@acme.test`,
    role: 'VIEWER',
  });
  await seed.db.runtime.withSystem(async (s) => {
    await s.objectType.updateMany({ where: { id: widgetTypeId }, data: { deletedAt: null } });
    await s.attribute.updateMany({
      where: { objectTypeId: widgetTypeId, isSystem: true },
      data: { deletedAt: null, purgeAfter: null },
    });
  });
  const attr = await owner.attribute.create({
    objectTypeId: widgetTypeId,
    apiSlug: `f_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    title: 'Field',
    type: 'TEXT',
  });
  const rec = await owner.record.create({
    objectType: 'widget',
    values: { name: `rec ${Date.now()}` },
  });
  const list = await owner.list.create({
    objectType: 'widget',
    name: 'Pipe',
    kind: 'PIPELINE',
    stages: [
      { id: 's1', label: 'One' },
      { id: 's2', label: 'Two' },
    ],
  });
  const entry = await owner.listEntry.add({ listId: list.id, recordId: rec.id });
  const view = await owner.view.create({ objectTypeId: widgetTypeId, name: 'Mine' });
  const job = await owner.import.create({
    objectType: 'widget',
    fileName: 'w.csv',
    csvText: toCsv(['name'], [['imported one']]),
  });
  const spare = await owner.record.create({
    objectType: 'widget',
    values: { name: `spare ${Date.now()}` },
  });
  const note = await owner.note.create({ recordId: rec.id, body: 'first note' });
  const task = await owner.task.create({ recordId: rec.id, title: 'follow up' });
  const person = await owner.person.create({ values: { name: 'Pat' } });
  const company = await owner.company.create({ values: { name: 'Acme Co' } });
  const deal = await owner.deal.create({ values: { name: 'Deal' } });
  const connectionLabel = 'Mock Platform — Mock Account 1 (@mock1)';
  const conn = await seed.db.runtime.withTenant(
    seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'),
    async (db) => {
      const issued = seed.mockPlatform.issueToken();
      const tokenRef = (
        await seed.sync.vault.putTokenSet(db, seed.acme.id, {
          accessToken: issued.accessToken,
          refreshToken: issued.refreshToken,
          scopes: ['read:posts', 'read:comments', 'write:reply_comment'],
          tokenType: 'Bearer',
          raw: {},
        })
      ).ref;
      const c = await upsertConnection(db, {
        workspaceId: seed.acme.id,
        platform: 'MOCK',
        label: connectionLabel,
        accountExternalId: 'acct_1',
        accountName: 'Mock Account 1',
        scopesGranted: ['read:posts', 'read:comments', 'write:reply_comment'],
        scopesRequired: ['read:posts', 'read:comments', 'write:reply_comment'],
        capabilities: ['read:posts', 'read:comments', 'write:reply_comment'],
        apiVersion: '2026-09',
        tokenRef,
        ownerUserId: seed.users.alice.id,
      });
      const err = await recordIntegrationError(db, {
        workspaceId: seed.acme.id,
        connectionId: c.id,
        platform: 'MOCK',
        error: new NexusError('RATE_LIMITED'),
      });
      const dl = await recordDeadLetter(db, {
        workspaceId: seed.acme.id,
        connectionId: c.id,
        queue: 'sync.delta',
        jobName: 'sync',
        payload: {
          workspaceId: seed.acme.id,
          connectionId: c.id,
          resource: 'mock.posts',
          trigger: 'MANUAL',
          lane: 'interactive',
        },
        error: new NexusError('PLATFORM_DOWN'),
        attempts: 6,
      });
      const identity = await db.identity.create({
        data: {
          workspaceId: seed.acme.id,
          platform: 'MOCK',
          externalId: `user_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          displayName: 'User 7',
          handle: 'user7',
        },
        select: { id: true },
      });
      const conversation = await db.conversation.create({
        data: {
          workspaceId: seed.acme.id,
          connectionId: c.id,
          platform: 'MOCK',
          kind: 'DM',
          externalId: `dm:user_7:${Date.now()}`,
          identityId: identity.id,
          lastMessageAt: new Date(),
          unreadCount: 1,
        },
        select: { id: true },
      });
      await db.message.create({
        data: {
          workspaceId: seed.acme.id,
          conversationId: conversation.id,
          externalId: `m_${Date.now()}`,
          direction: 'INBOUND',
          authorIdentityId: identity.id,
          body: 'hello?',
          attachments: [],
          sentAt: new Date(),
          deliveryState: 'DELIVERED',
          replyWindowExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return { id: c.id, errorId: err.id, deadLetterId: dl.id, conversationId: conversation.id };
    },
  );
  // Phase 6 rows: a linked identity, an unresolved one with a pending suggestion, a merge to undo.
  const person2 = await owner.person.create({ values: { name: 'Pat Two' } });
  const company2 = await owner.company.create({ values: { name: 'Acme Two' } });
  const deal2 = await owner.deal.create({ values: { name: 'Deal Two' } });
  const w1 = await owner.record.create({
    objectType: 'widget',
    values: { name: `mw ${Date.now()}` },
  });
  const w2 = await owner.record.create({
    objectType: 'widget',
    values: { name: `ml ${Date.now()}` },
  });
  const p6 = await seed.db.runtime.withTenant(
    seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER'),
    async (db) => {
      const actor = seed.actorFor(seed.users.alice, seed.acme.id, 'OWNER');
      const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const linked = await upsertIdentity(db, {
        workspaceId: seed.acme.id,
        platform: 'INSTAGRAM',
        externalId: `ig_${stamp}`,
        seenAt: new Date(),
        handle: `pat_${stamp}`,
        displayName: 'Pat',
      });
      await linkIdentity(db, actor, {
        identityId: linked.id,
        personRecordId: person.id,
        method: 'MANUAL',
        confidence: 1,
        evidence: { score: 1, signals: [], note: 'seed' },
        confirmed: true,
      });
      const unresolved = await upsertIdentity(db, {
        workspaceId: seed.acme.id,
        platform: 'X',
        externalId: `x_${stamp}`,
        seenAt: new Date(),
        handle: `pat_x_${stamp}`,
        displayName: 'Pat',
      });
      const suggestion = await db.mergeSuggestion.create({
        data: {
          workspaceId: seed.acme.id,
          identityId: unresolved.id,
          rightRecordId: person.id,
          score: 0.4,
          signals: { score: 0.4, method: 'NAME_FUZZY', signals: [] },
          status: 'PENDING',
        },
        select: { id: true },
      });
      const merge = await mergeRecords(db, actor, { winnerId: w1.id, loserId: w2.id });
      return {
        identityId: linked.id,
        unresolvedIdentityId: unresolved.id,
        suggestionId: suggestion.id,
        mergeId: merge.mergeId,
      };
    },
  );
  const canned = await owner.cannedReply.create({
    title: `Seed reply ${Date.now()}`,
    body: 'Hello from the seed',
  });
  return {
    cannedReplyId: canned.id,
    ...p6,
    person2Id: person2.id,
    company2Id: company2.id,
    deal2Id: deal2.id,
    connectionId: conn.id,
    connectionLabel,
    integrationErrorId: conn.errorId,
    deadLetterId: conn.deadLetterId,
    conversationId: conn.conversationId,
    spareRecordId: spare.id,
    noteId: note.id,
    taskId: task.id,
    personId: person.id,
    companyId: company.id,
    dealId: deal.id,
    carolMembershipId: carol.id,
    invitationId: inv.id,
    auditCursor: undefined,
    objectTypeId: widgetTypeId,
    attributeId: attr.id,
    recordId: rec.id,
    listId: list.id,
    entryId: entry.id,
    viewId: view.id,
    importJobId: job.id,
  };
}

const codeOf = (e: unknown): string =>
  e instanceof TRPCError ? e.code : `not-a-TRPCError: ${String(e)}`;

beforeAll(async () => {
  seed = await seedWorkspaces();
  const owner = seed.caller(seed.users.alice, 'acme');
  const ot = await owner.objectType.create({
    apiSlug: 'widget',
    singular: 'Widget',
    plural: 'Widgets',
  });
  widgetTypeId = ot.id;
}, 120_000);

afterAll(async () => {
  await seed?.db.close();
});

describe('router manifest', () => {
  it('every procedure has an isolation fixture', () => {
    const missing = procedureManifest()
      .map((p) => p.path)
      .filter((p) => !(p in FIXTURES));
    expect(missing, `add fixtures in server/isolation.test.ts for: ${missing.join(', ')}`).toEqual(
      [],
    );
    const stale = Object.keys(FIXTURES).filter(
      (p) => !procedureManifest().some((m) => m.path === p),
    );
    expect(stale, `fixtures for removed procedures: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('cross-tenant isolation', () => {
  const tenantProcs = () => procedureManifest().filter((p) => FIXTURES[p.path]?.tier === 'tenant');

  it('a non-member addressing workspace A gets NOT_FOUND on every tenant procedure', async () => {
    const ids = await freshIds();
    for (const p of tenantProcs()) {
      const bobOnAcme = seed.caller(seed.users.bob, 'acme');
      const result = await callPath(bobOnAcme, p.path, FIXTURES[p.path]!.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('NOT_FOUND');
    }
  }, 120_000);

  it("a member of B using A's ids gets NOT_FOUND, and A is untouched", async () => {
    const ids = await freshIds();
    for (const p of tenantProcs()) {
      const fx = FIXTURES[p.path]!;
      if (!fx.crossInput) continue;
      const bobOnGlobex = seed.caller(seed.users.bob, 'globex');
      const result = await callPath(bobOnGlobex, p.path, fx.crossInput(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe(fx.crossExpect ?? 'NOT_FOUND');
    }
    const carol = await seed.db.runtime.withSystem((s) =>
      s.membership.findUniqueOrThrow({ where: { id: ids.carolMembershipId } }),
    );
    expect(carol.deletedAt).toBeNull();
    expect(carol.role).toBe('VIEWER');
    const rec = await seed.db.runtime.withSystem((s) =>
      s.record.findUniqueOrThrow({ where: { id: ids.recordId } }),
    );
    expect(JSON.stringify(rec.values)).not.toContain('Pwned');
    expect(rec.deletedAt).toBeNull();
    for (const id of [ids.personId, ids.companyId, ids.dealId]) {
      const r = await seed.db.runtime.withSystem((s) =>
        s.record.findUniqueOrThrow({ where: { id } }),
      );
      expect(JSON.stringify(r.values)).not.toContain('Pwned');
    }
    const attr = await seed.db.runtime.withSystem((s) =>
      s.attribute.findUniqueOrThrow({ where: { id: ids.attributeId } }),
    );
    expect(attr.title).toBe('Field');
    expect(attr.deletedAt).toBeNull();
  }, 120_000);

  it('an anonymous caller gets UNAUTHORIZED on user and tenant procedures', async () => {
    const ids = await freshIds();
    for (const p of procedureManifest()) {
      const fx = FIXTURES[p.path]!;
      if (fx.tier === 'public') continue;
      const anon = seed.caller(null, 'acme');
      const result = await callPath(anon, p.path, fx.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('UNAUTHORIZED');
    }
  }, 120_000);

  it("tenant reads never return another workspace's rows", async () => {
    const alice = seed.caller(seed.users.alice, 'acme');
    const members = await alice.member.list();
    expect(members.every((m) => ['alice@acme.test', 'carol@acme.test'].includes(m.email))).toBe(
      true,
    );
    const audit = await alice.audit.list({ limit: 100 });
    const ids = new Set(audit.items.map((i) => i.id));
    const globexRows = await seed.db.runtime.withSystem((s) =>
      s.auditLog.findMany({ where: { workspaceId: seed.globex.id } }),
    );
    expect(globexRows.length).toBeGreaterThan(0);
    for (const r of globexRows) expect(ids.has(r.id)).toBe(false);
    const types = await alice.objectType.list();
    expect(types.map((t) => t.apiSlug)).toEqual(
      expect.arrayContaining(['person', 'company', 'deal', 'widget']),
    );
    const bob = seed.caller(seed.users.bob, 'globex');
    expect((await bob.objectType.list()).some((t) => t.apiSlug === 'widget')).toBe(false);
  });
});

describe('a viewer cannot mutate anything', () => {
  it('every tenant mutation returns FORBIDDEN for a VIEWER', async () => {
    const ids = await freshIds();
    const mutations = procedureManifest().filter(
      (p) => p.type === 'mutation' && FIXTURES[p.path]?.tier === 'tenant',
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const p of mutations) {
      const carol = seed.caller(seed.users.carol, 'acme');
      const result = await callPath(carol, p.path, FIXTURES[p.path]!.input(ids)).then(
        () => 'ok',
        (e: unknown) => codeOf(e),
      );
      expect(result, p.path).toBe('FORBIDDEN');
    }
  }, 120_000);

  it('a viewer can still read', async () => {
    const carol = seed.caller(seed.users.carol, 'acme');
    expect((await carol.workspace.current()).role).toBe('VIEWER');
    expect((await carol.member.list()).length).toBeGreaterThan(0);
    expect(
      (await carol.record.query({ objectType: 'widget' })).attributes.every(
        (a) => a.access === 'READ',
      ),
    ).toBe(true);
  });
});

describe('every mutation writes an audit row', () => {
  it('for each mutation, the AuditLog grows inside the same call', async () => {
    const mutations = procedureManifest().filter((p) => p.type === 'mutation');
    for (const p of mutations) {
      const fx = FIXTURES[p.path]!;
      const ids = await freshIds();
      const before = await seed.db.runtime.withSystem((s) => s.auditLog.count());
      const owner = seed.caller(seed.users.alice, fx.tier === 'tenant' ? 'acme' : null);
      if (p.path === 'invitation.accept') {
        const raw = await inviteBob();
        await seed.caller(seed.users.bob, null).invitation.accept({ token: raw });
      } else if (p.path === 'attribute.restore') {
        await owner.attribute.delete({ id: ids.attributeId });
        const mid = await seed.db.runtime.withSystem((s) => s.auditLog.count());
        await owner.attribute.restore({ id: ids.attributeId });
        expect(await seed.db.runtime.withSystem((s) => s.auditLog.count())).toBeGreaterThan(mid);
        continue;
      } else if (p.path === 'import.rollback') {
        await owner.import.run({ id: ids.importJobId });
        const mid = await seed.db.runtime.withSystem((s) => s.auditLog.count());
        await owner.import.rollback({ id: ids.importJobId });
        expect(await seed.db.runtime.withSystem((s) => s.auditLog.count())).toBeGreaterThan(mid);
        continue;
      } else {
        await callPath(owner, p.path, fx.input(ids));
      }
      const after = await seed.db.runtime.withSystem((s) => s.auditLog.count());
      expect(after, `${p.path} wrote no audit row`).toBeGreaterThan(before);
    }
  }, 300_000);
});

async function inviteBob(): Promise<string> {
  const alice = seed.caller(seed.users.alice, 'acme');
  await seed.db.runtime.withSystem((s) =>
    s.membership.deleteMany({ where: { workspaceId: seed.acme.id, userId: seed.users.bob.id } }),
  );
  await alice.invitation.create({ email: seed.users.bob.email, role: 'MEMBER' });
  const sent = seed.mail.last('invitation');
  const link = sent?.text.match(/https?:\/\/\S+\/invite\/(\S+)/);
  if (!link?.[1]) throw new Error('invitation mail did not contain a link');
  return link[1];
}
