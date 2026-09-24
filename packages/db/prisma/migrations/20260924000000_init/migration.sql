-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ConnPermission" AS ENUM ('READ', 'ENGAGE', 'PUBLISH', 'CONFIGURE');

-- CreateEnum
CREATE TYPE "GrantSubjectType" AS ENUM ('ROLE', 'USER');

-- CreateEnum
CREATE TYPE "AttributeAccess" AS ENUM ('HIDDEN', 'READ', 'WRITE');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'X', 'LINKEDIN', 'TIKTOK', 'YOUTUBE', 'GMAIL', 'GOOGLE_CALENDAR', 'GOOGLE_BUSINESS', 'KEITARO', 'MOCK');

-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('TEXT', 'NUMBER', 'CURRENCY', 'DATE', 'DATETIME', 'SELECT', 'MULTISELECT', 'BOOLEAN', 'EMAIL', 'PHONE', 'URL', 'RATING', 'STATUS', 'RELATIONSHIP', 'USER', 'LOCATION', 'AI_RESEARCH', 'FORMULA', 'ROLLUP', 'SOCIAL_HANDLE');

-- CreateEnum
CREATE TYPE "ListKind" AS ENUM ('PIPELINE', 'COLLECTION');

-- CreateEnum
CREATE TYPE "ConvStatus" AS ENUM ('OPEN', 'SNOOZED', 'CLOSED', 'SPAM');

-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('DM', 'COMMENT_THREAD', 'MENTION', 'REVIEW', 'EMAIL_THREAD');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "TimelineType" AS ENUM ('MESSAGE', 'COMMENT', 'MENTION', 'POST_ENGAGEMENT', 'LEAD_FORM', 'EMAIL', 'MEETING', 'CALL', 'NOTE', 'TASK', 'STAGE_CHANGE', 'FIELD_CHANGE', 'DEAL_EVENT', 'AI_INSIGHT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "LinkMethod" AS ENUM ('EXACT_EMAIL', 'PHONE', 'OAUTH_SELF', 'DOMAIN', 'NAME_FUZZY', 'HANDLE_MATCH', 'MANUAL', 'AI_INFERRED', 'PLATFORM_PROVIDED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_MERGED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ConnStatus" AS ENUM ('CONNECTED', 'DEGRADED', 'PAUSED', 'RECONNECT_REQUIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('BACKFILL', 'SCHEDULE', 'WEBHOOK', 'MANUAL', 'REPLAY');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MergeState" AS ENUM ('ACTIVE', 'MERGED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'API_KEY', 'SYSTEM', 'WORKFLOW', 'CONNECTOR');

-- CreateEnum
CREATE TYPE "AiInsightKind" AS ENUM ('SUMMARY', 'SENTIMENT', 'INTENT', 'NEXT_BEST_ACTION', 'CHURN_RISK', 'RESEARCH');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ViewLayout" AS ENUM ('TABLE', 'BOARD', 'CALENDAR', 'TIMELINE');

-- CreateEnum
CREATE TYPE "IntegrationErrorClass" AS ENUM ('AUTH_EXPIRED', 'SCOPE_MISSING', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'PLATFORM_DOWN', 'SCHEMA_DRIFT', 'POLICY_BLOCKED', 'DUPLICATE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('READ', 'WRITE', 'ADMIN');

-- CreateEnum
CREATE TYPE "OutboundDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "DsrKind" AS ENUM ('ACCESS', 'PORTABILITY', 'ERASURE', 'RECTIFICATION');

-- CreateEnum
CREATE TYPE "DsrStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'EXPORT_READY', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "region" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "avatarUrl" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "invitedById" TEXT,
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectType" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "apiSlug" TEXT NOT NULL,
    "singular" TEXT NOT NULL,
    "plural" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ObjectType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attribute" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectTypeId" TEXT NOT NULL,
    "apiSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "AttributeType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isUnique" BOOLEAN NOT NULL DEFAULT false,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isIndexed" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Attribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Record" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectTypeId" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "searchVector" tsvector,
    "embedding" vector(1536),
    "createdById" TEXT,
    "mergedIntoId" TEXT,
    "mergeState" "MergeState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordRelation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fromRecordId" TEXT NOT NULL,
    "toRecordId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecordRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "List" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectTypeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ListKind" NOT NULL DEFAULT 'COLLECTION',
    "description" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "List_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListAttribute" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "apiSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ListAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "stage" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListStageHistory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listEntryId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "changedById" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectTypeId" TEXT,
    "listId" TEXT,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "layout" "ViewLayout" NOT NULL DEFAULT 'TABLE',
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "columns" JSONB NOT NULL DEFAULT '[]',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "sorts" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributePermission" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "access" "AttributeAccess" NOT NULL DEFAULT 'READ',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AttributePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "profileUrl" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "personRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "personRecordId" TEXT NOT NULL,
    "method" "LinkMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "IdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeSuggestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leftRecordId" TEXT NOT NULL,
    "rightRecordId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "signals" JSONB NOT NULL DEFAULT '{}',
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MergeSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NeverMerge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leftRecordId" TEXT NOT NULL,
    "rightRecordId" TEXT NOT NULL,
    "decidedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "NeverMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordMerge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "mergedById" TEXT,
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    "unmergedAt" TIMESTAMP(3),
    "unmergedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "subject" TEXT,
    "identityId" TEXT,
    "personRecordId" TEXT,
    "assigneeId" TEXT,
    "status" "ConvStatus" NOT NULL DEFAULT 'OPEN',
    "snoozedUntil" TIMESTAMP(3),
    "slaDueAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "parentExternalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "authorIdentityId" TEXT,
    "authorUserId" TEXT,
    "outboundActionId" TEXT,
    "body" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "sentAt" TIMESTAMP(3) NOT NULL,
    "deliveryState" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureHint" TEXT,
    "replyWindowExpiresAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "recordId" TEXT,
    "identityId" TEXT,
    "type" "TimelineType" NOT NULL,
    "platform" "Platform",
    "connectionId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorIdentityId" TEXT,
    "actorUserId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "sourceUrl" TEXT,
    "externalObjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "label" TEXT NOT NULL,
    "accountExternalId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountAvatarUrl" TEXT,
    "status" "ConnStatus" NOT NULL DEFAULT 'CONNECTED',
    "scopesGranted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopesRequired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "degradedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "apiVersion" TEXT NOT NULL,
    "tokenRef" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshableUntil" TIMESTAMP(3),
    "webhookSecretRef" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "fieldMappingId" TEXT,
    "retentionDays" INTEGER,
    "ownerUserId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "pausedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "subjectType" "GrantSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "permission" "ConnPermission" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ConnectionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncCursor" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "cursor" TEXT,
    "highWaterMark" TIMESTAMP(3),
    "overlapSeconds" INTEGER NOT NULL DEFAULT 300,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "itemsFetched" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
    "itemsSkipped" INTEGER NOT NULL DEFAULT 0,
    "budgetSpent" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "remediation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalObject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "raw" JSONB NOT NULL,
    "apiVersion" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "normalizedAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "connectionId" TEXT,
    "platform" "Platform" NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "body" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateBudget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "resetsAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RateBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "externalId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OutboundAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationError" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "syncRunId" TEXT,
    "externalObjectId" TEXT,
    "outboundActionId" TEXT,
    "platform" "Platform",
    "errorClass" "IntegrationErrorClass" NOT NULL DEFAULT 'UNKNOWN',
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "remediation" TEXT,
    "httpStatus" INTEGER,
    "details" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionDriftSample" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sampleSize" INTEGER NOT NULL,
    "driftCount" INTEGER NOT NULL,
    "repairedCount" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionDriftSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FieldMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldMappingRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fieldMappingId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "transform" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FieldMappingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformComplianceNote" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PlatformComplianceNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "context" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "recordId" TEXT,
    "conversationId" TEXT,
    "kind" "AiInsightKind" NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "vector" vector(1536) NOT NULL,
    "model" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "actorRef" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "createdById" TEXT,
    "recordId" TEXT,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "recordId" TEXT,
    "conversationId" TEXT,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "bodyJson" JSONB,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[] DEFAULT ARRAY['READ']::"ApiKeyScope"[],
    "rateLimitPerMinute" INTEGER,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundWebhookSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OutboundWebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundWebhookDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OutboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "DsrKind" NOT NULL,
    "status" "DsrStatus" NOT NULL DEFAULT 'RECEIVED',
    "subjectEmail" CITEXT,
    "subjectPhone" TEXT,
    "subjectRecordId" TEXT,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "exportRef" TEXT,
    "tombstone" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_workspaceId_role_idx" ON "Membership"("workspaceId", "role");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE INDEX "Membership_invitedById_idx" ON "Membership"("invitedById");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_workspaceId_name_key" ON "Team"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_workspaceId_userId_idx" ON "TeamMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");

-- CreateIndex
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_workspaceId_teamId_userId_key" ON "TeamMember"("workspaceId", "teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectType_workspaceId_apiSlug_key" ON "ObjectType"("workspaceId", "apiSlug");

-- CreateIndex
CREATE INDEX "Attribute_workspaceId_objectTypeId_position_idx" ON "Attribute"("workspaceId", "objectTypeId", "position");

-- CreateIndex
CREATE INDEX "Attribute_objectTypeId_idx" ON "Attribute"("objectTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Attribute_workspaceId_objectTypeId_apiSlug_key" ON "Attribute"("workspaceId", "objectTypeId", "apiSlug");

-- CreateIndex
CREATE INDEX "Record_workspaceId_objectTypeId_updatedAt_idx" ON "Record"("workspaceId", "objectTypeId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Record_workspaceId_objectTypeId_mergeState_idx" ON "Record"("workspaceId", "objectTypeId", "mergeState");

-- CreateIndex
CREATE INDEX "Record_workspaceId_mergedIntoId_idx" ON "Record"("workspaceId", "mergedIntoId");

-- CreateIndex
CREATE INDEX "Record_objectTypeId_idx" ON "Record"("objectTypeId");

-- CreateIndex
CREATE INDEX "Record_createdById_idx" ON "Record"("createdById");

-- CreateIndex
CREATE INDEX "RecordRelation_workspaceId_toRecordId_attributeId_idx" ON "RecordRelation"("workspaceId", "toRecordId", "attributeId");

-- CreateIndex
CREATE INDEX "RecordRelation_attributeId_idx" ON "RecordRelation"("attributeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordRelation_workspaceId_fromRecordId_attributeId_toRecor_key" ON "RecordRelation"("workspaceId", "fromRecordId", "attributeId", "toRecordId");

-- CreateIndex
CREATE INDEX "List_workspaceId_objectTypeId_idx" ON "List"("workspaceId", "objectTypeId");

-- CreateIndex
CREATE INDEX "List_objectTypeId_idx" ON "List"("objectTypeId");

-- CreateIndex
CREATE INDEX "ListAttribute_listId_idx" ON "ListAttribute"("listId");

-- CreateIndex
CREATE UNIQUE INDEX "ListAttribute_workspaceId_listId_apiSlug_key" ON "ListAttribute"("workspaceId", "listId", "apiSlug");

-- CreateIndex
CREATE INDEX "ListEntry_workspaceId_listId_position_idx" ON "ListEntry"("workspaceId", "listId", "position");

-- CreateIndex
CREATE INDEX "ListEntry_workspaceId_listId_stage_idx" ON "ListEntry"("workspaceId", "listId", "stage");

-- CreateIndex
CREATE INDEX "ListEntry_workspaceId_recordId_idx" ON "ListEntry"("workspaceId", "recordId");

-- CreateIndex
CREATE INDEX "ListEntry_recordId_idx" ON "ListEntry"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "ListEntry_workspaceId_listId_recordId_key" ON "ListEntry"("workspaceId", "listId", "recordId");

-- CreateIndex
CREATE INDEX "ListStageHistory_workspaceId_listEntryId_at_idx" ON "ListStageHistory"("workspaceId", "listEntryId", "at" DESC);

-- CreateIndex
CREATE INDEX "ListStageHistory_listEntryId_idx" ON "ListStageHistory"("listEntryId");

-- CreateIndex
CREATE INDEX "ListStageHistory_changedById_idx" ON "ListStageHistory"("changedById");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_objectTypeId_position_idx" ON "SavedView"("workspaceId", "objectTypeId", "position");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_listId_position_idx" ON "SavedView"("workspaceId", "listId", "position");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_ownerId_idx" ON "SavedView"("workspaceId", "ownerId");

-- CreateIndex
CREATE INDEX "SavedView_objectTypeId_idx" ON "SavedView"("objectTypeId");

-- CreateIndex
CREATE INDEX "SavedView_listId_idx" ON "SavedView"("listId");

-- CreateIndex
CREATE INDEX "SavedView_ownerId_idx" ON "SavedView"("ownerId");

-- CreateIndex
CREATE INDEX "AttributePermission_attributeId_idx" ON "AttributePermission"("attributeId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributePermission_workspaceId_attributeId_role_key" ON "AttributePermission"("workspaceId", "attributeId", "role");

-- CreateIndex
CREATE INDEX "Identity_workspaceId_email_idx" ON "Identity"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Identity_workspaceId_phone_idx" ON "Identity"("workspaceId", "phone");

-- CreateIndex
CREATE INDEX "Identity_workspaceId_platform_handle_idx" ON "Identity"("workspaceId", "platform", "handle");

-- CreateIndex
CREATE INDEX "Identity_workspaceId_personRecordId_idx" ON "Identity"("workspaceId", "personRecordId");

-- CreateIndex
CREATE INDEX "Identity_personRecordId_idx" ON "Identity"("personRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_workspaceId_platform_externalId_key" ON "Identity"("workspaceId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "IdentityLink_workspaceId_identityId_idx" ON "IdentityLink"("workspaceId", "identityId");

-- CreateIndex
CREATE INDEX "IdentityLink_workspaceId_personRecordId_idx" ON "IdentityLink"("workspaceId", "personRecordId");

-- CreateIndex
CREATE INDEX "IdentityLink_identityId_idx" ON "IdentityLink"("identityId");

-- CreateIndex
CREATE INDEX "IdentityLink_personRecordId_idx" ON "IdentityLink"("personRecordId");

-- CreateIndex
CREATE INDEX "IdentityLink_confirmedById_idx" ON "IdentityLink"("confirmedById");

-- CreateIndex
CREATE INDEX "MergeSuggestion_workspaceId_status_score_idx" ON "MergeSuggestion"("workspaceId", "status", "score" DESC);

-- CreateIndex
CREATE INDEX "MergeSuggestion_workspaceId_rightRecordId_idx" ON "MergeSuggestion"("workspaceId", "rightRecordId");

-- CreateIndex
CREATE INDEX "MergeSuggestion_leftRecordId_idx" ON "MergeSuggestion"("leftRecordId");

-- CreateIndex
CREATE INDEX "MergeSuggestion_rightRecordId_idx" ON "MergeSuggestion"("rightRecordId");

-- CreateIndex
CREATE INDEX "MergeSuggestion_decidedById_idx" ON "MergeSuggestion"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "MergeSuggestion_workspaceId_leftRecordId_rightRecordId_key" ON "MergeSuggestion"("workspaceId", "leftRecordId", "rightRecordId");

-- CreateIndex
CREATE INDEX "NeverMerge_workspaceId_rightRecordId_idx" ON "NeverMerge"("workspaceId", "rightRecordId");

-- CreateIndex
CREATE INDEX "NeverMerge_leftRecordId_idx" ON "NeverMerge"("leftRecordId");

-- CreateIndex
CREATE INDEX "NeverMerge_rightRecordId_idx" ON "NeverMerge"("rightRecordId");

-- CreateIndex
CREATE INDEX "NeverMerge_decidedById_idx" ON "NeverMerge"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "NeverMerge_workspaceId_leftRecordId_rightRecordId_key" ON "NeverMerge"("workspaceId", "leftRecordId", "rightRecordId");

-- CreateIndex
CREATE INDEX "RecordMerge_workspaceId_winnerId_mergedAt_idx" ON "RecordMerge"("workspaceId", "winnerId", "mergedAt" DESC);

-- CreateIndex
CREATE INDEX "RecordMerge_workspaceId_loserId_idx" ON "RecordMerge"("workspaceId", "loserId");

-- CreateIndex
CREATE INDEX "RecordMerge_winnerId_idx" ON "RecordMerge"("winnerId");

-- CreateIndex
CREATE INDEX "RecordMerge_loserId_idx" ON "RecordMerge"("loserId");

-- CreateIndex
CREATE INDEX "RecordMerge_mergedById_idx" ON "RecordMerge"("mergedById");

-- CreateIndex
CREATE INDEX "RecordMerge_unmergedById_idx" ON "RecordMerge"("unmergedById");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_lastMessageAt_idx" ON "Conversation"("workspaceId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assigneeId_status_lastMessageAt_idx" ON "Conversation"("workspaceId", "assigneeId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_personRecordId_lastMessageAt_idx" ON "Conversation"("workspaceId", "personRecordId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_identityId_lastMessageAt_idx" ON "Conversation"("workspaceId", "identityId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_connectionId_lastMessageAt_idx" ON "Conversation"("workspaceId", "connectionId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_snoozedUntil_idx" ON "Conversation"("workspaceId", "status", "snoozedUntil");

-- CreateIndex
CREATE INDEX "Conversation_connectionId_idx" ON "Conversation"("connectionId");

-- CreateIndex
CREATE INDEX "Conversation_identityId_idx" ON "Conversation"("identityId");

-- CreateIndex
CREATE INDEX "Conversation_personRecordId_idx" ON "Conversation"("personRecordId");

-- CreateIndex
CREATE INDEX "Conversation_assigneeId_idx" ON "Conversation"("assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_connectionId_externalId_key" ON "Conversation"("workspaceId", "connectionId", "externalId");

-- CreateIndex
CREATE INDEX "Message_workspaceId_conversationId_sentAt_idx" ON "Message"("workspaceId", "conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "Message_workspaceId_authorIdentityId_idx" ON "Message"("workspaceId", "authorIdentityId");

-- CreateIndex
CREATE INDEX "Message_workspaceId_deliveryState_idx" ON "Message"("workspaceId", "deliveryState");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_authorIdentityId_idx" ON "Message"("authorIdentityId");

-- CreateIndex
CREATE INDEX "Message_authorUserId_idx" ON "Message"("authorUserId");

-- CreateIndex
CREATE INDEX "Message_outboundActionId_idx" ON "Message"("outboundActionId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_conversationId_externalId_key" ON "Message"("workspaceId", "conversationId", "externalId");

-- CreateIndex
CREATE INDEX "TimelineEvent_workspaceId_recordId_occurredAt_idx" ON "TimelineEvent"("workspaceId", "recordId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "TimelineEvent_workspaceId_identityId_occurredAt_idx" ON "TimelineEvent"("workspaceId", "identityId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "TimelineEvent_workspaceId_connectionId_occurredAt_idx" ON "TimelineEvent"("workspaceId", "connectionId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "TimelineEvent_workspaceId_type_occurredAt_idx" ON "TimelineEvent"("workspaceId", "type", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "TimelineEvent_workspaceId_externalObjectId_idx" ON "TimelineEvent"("workspaceId", "externalObjectId");

-- CreateIndex
CREATE INDEX "TimelineEvent_recordId_idx" ON "TimelineEvent"("recordId");

-- CreateIndex
CREATE INDEX "TimelineEvent_identityId_idx" ON "TimelineEvent"("identityId");

-- CreateIndex
CREATE INDEX "TimelineEvent_connectionId_idx" ON "TimelineEvent"("connectionId");

-- CreateIndex
CREATE INDEX "TimelineEvent_actorIdentityId_idx" ON "TimelineEvent"("actorIdentityId");

-- CreateIndex
CREATE INDEX "TimelineEvent_actorUserId_idx" ON "TimelineEvent"("actorUserId");

-- CreateIndex
CREATE INDEX "TimelineEvent_externalObjectId_idx" ON "TimelineEvent"("externalObjectId");

-- CreateIndex
CREATE INDEX "Connection_workspaceId_status_idx" ON "Connection"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Connection_workspaceId_platform_idx" ON "Connection"("workspaceId", "platform");

-- CreateIndex
CREATE INDEX "Connection_workspaceId_tokenExpiresAt_idx" ON "Connection"("workspaceId", "tokenExpiresAt");

-- CreateIndex
CREATE INDEX "Connection_fieldMappingId_idx" ON "Connection"("fieldMappingId");

-- CreateIndex
CREATE INDEX "Connection_ownerUserId_idx" ON "Connection"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_workspaceId_platform_accountExternalId_key" ON "Connection"("workspaceId", "platform", "accountExternalId");

-- CreateIndex
CREATE INDEX "ConnectionGrant_workspaceId_subjectType_subjectId_idx" ON "ConnectionGrant"("workspaceId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ConnectionGrant_connectionId_idx" ON "ConnectionGrant"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionGrant_workspaceId_connectionId_subjectType_subjec_key" ON "ConnectionGrant"("workspaceId", "connectionId", "subjectType", "subjectId", "permission");

-- CreateIndex
CREATE INDEX "SyncCursor_connectionId_idx" ON "SyncCursor"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCursor_workspaceId_connectionId_resource_key" ON "SyncCursor"("workspaceId", "connectionId", "resource");

-- CreateIndex
CREATE INDEX "SyncRun_workspaceId_connectionId_startedAt_idx" ON "SyncRun"("workspaceId", "connectionId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "SyncRun_workspaceId_status_startedAt_idx" ON "SyncRun"("workspaceId", "status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "SyncRun_connectionId_idx" ON "SyncRun"("connectionId");

-- CreateIndex
CREATE INDEX "ExternalObject_workspaceId_connectionId_fetchedAt_idx" ON "ExternalObject"("workspaceId", "connectionId", "fetchedAt" DESC);

-- CreateIndex
CREATE INDEX "ExternalObject_workspaceId_connectionId_kind_parentExternal_idx" ON "ExternalObject"("workspaceId", "connectionId", "kind", "parentExternalId");

-- CreateIndex
CREATE INDEX "ExternalObject_workspaceId_normalizedAt_idx" ON "ExternalObject"("workspaceId", "normalizedAt");

-- CreateIndex
CREATE INDEX "ExternalObject_workspaceId_quarantinedAt_idx" ON "ExternalObject"("workspaceId", "quarantinedAt");

-- CreateIndex
CREATE INDEX "ExternalObject_connectionId_idx" ON "ExternalObject"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalObject_workspaceId_connectionId_kind_externalId_key" ON "ExternalObject"("workspaceId", "connectionId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "WebhookEvent_workspaceId_receivedAt_idx" ON "WebhookEvent"("workspaceId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_workspaceId_connectionId_receivedAt_idx" ON "WebhookEvent"("workspaceId", "connectionId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_platform_receivedAt_idx" ON "WebhookEvent"("platform", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_receivedAt_idx" ON "WebhookEvent"("processedAt", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_connectionId_idx" ON "WebhookEvent"("connectionId");

-- CreateIndex
CREATE INDEX "RateBudget_connectionId_idx" ON "RateBudget"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "RateBudget_workspaceId_connectionId_window_key" ON "RateBudget"("workspaceId", "connectionId", "window");

-- CreateIndex
CREATE INDEX "OutboundAction_workspaceId_status_scheduledFor_idx" ON "OutboundAction"("workspaceId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "OutboundAction_workspaceId_connectionId_createdAt_idx" ON "OutboundAction"("workspaceId", "connectionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OutboundAction_workspaceId_conversationId_idx" ON "OutboundAction"("workspaceId", "conversationId");

-- CreateIndex
CREATE INDEX "OutboundAction_connectionId_idx" ON "OutboundAction"("connectionId");

-- CreateIndex
CREATE INDEX "OutboundAction_conversationId_idx" ON "OutboundAction"("conversationId");

-- CreateIndex
CREATE INDEX "OutboundAction_requestedByUserId_idx" ON "OutboundAction"("requestedByUserId");

-- CreateIndex
CREATE INDEX "OutboundAction_approvedByUserId_idx" ON "OutboundAction"("approvedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundAction_workspaceId_connectionId_idempotencyKey_key" ON "OutboundAction"("workspaceId", "connectionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "IntegrationError_workspaceId_connectionId_occurredAt_idx" ON "IntegrationError"("workspaceId", "connectionId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "IntegrationError_workspaceId_errorClass_resolvedAt_idx" ON "IntegrationError"("workspaceId", "errorClass", "resolvedAt");

-- CreateIndex
CREATE INDEX "IntegrationError_workspaceId_syncRunId_idx" ON "IntegrationError"("workspaceId", "syncRunId");

-- CreateIndex
CREATE INDEX "IntegrationError_connectionId_idx" ON "IntegrationError"("connectionId");

-- CreateIndex
CREATE INDEX "IntegrationError_syncRunId_idx" ON "IntegrationError"("syncRunId");

-- CreateIndex
CREATE INDEX "IntegrationError_externalObjectId_idx" ON "IntegrationError"("externalObjectId");

-- CreateIndex
CREATE INDEX "IntegrationError_outboundActionId_idx" ON "IntegrationError"("outboundActionId");

-- CreateIndex
CREATE INDEX "IntegrationError_resolvedById_idx" ON "IntegrationError"("resolvedById");

-- CreateIndex
CREATE INDEX "ConnectionDriftSample_workspaceId_connectionId_sampledAt_idx" ON "ConnectionDriftSample"("workspaceId", "connectionId", "sampledAt" DESC);

-- CreateIndex
CREATE INDEX "ConnectionDriftSample_connectionId_idx" ON "ConnectionDriftSample"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMapping_workspaceId_platform_name_key" ON "FieldMapping"("workspaceId", "platform", "name");

-- CreateIndex
CREATE INDEX "FieldMappingRule_workspaceId_attributeId_idx" ON "FieldMappingRule"("workspaceId", "attributeId");

-- CreateIndex
CREATE INDEX "FieldMappingRule_fieldMappingId_idx" ON "FieldMappingRule"("fieldMappingId");

-- CreateIndex
CREATE INDEX "FieldMappingRule_attributeId_idx" ON "FieldMappingRule"("attributeId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMappingRule_workspaceId_fieldMappingId_sourceKind_sour_key" ON "FieldMappingRule"("workspaceId", "fieldMappingId", "sourceKind", "sourcePath");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformComplianceNote_platform_key_key" ON "PlatformComplianceNote"("platform", "key");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_enabled_idx" ON "Workflow"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "Workflow_createdById_idx" ON "Workflow"("createdById");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_workflowId_startedAt_idx" ON "WorkflowRun"("workspaceId", "workflowId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_status_startedAt_idx" ON "WorkflowRun"("workspaceId", "status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_idx" ON "WorkflowRun"("workflowId");

-- CreateIndex
CREATE INDEX "AiInsight_workspaceId_recordId_generatedAt_idx" ON "AiInsight"("workspaceId", "recordId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "AiInsight_workspaceId_conversationId_generatedAt_idx" ON "AiInsight"("workspaceId", "conversationId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "AiInsight_workspaceId_kind_generatedAt_idx" ON "AiInsight"("workspaceId", "kind", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "AiInsight_recordId_idx" ON "AiInsight"("recordId");

-- CreateIndex
CREATE INDEX "AiInsight_conversationId_idx" ON "AiInsight"("conversationId");

-- CreateIndex
CREATE INDEX "AiInsight_acceptedById_idx" ON "AiInsight"("acceptedById");

-- CreateIndex
CREATE UNIQUE INDEX "Embedding_workspaceId_sourceType_sourceId_model_chunkIndex_key" ON "Embedding"("workspaceId", "sourceType", "sourceId", "model", "chunkIndex");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_at_idx" ON "AuditLog"("workspaceId", "at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_targetType_targetId_at_idx" ON "AuditLog"("workspaceId", "targetType", "targetId", "at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_actorUserId_at_idx" ON "AuditLog"("workspaceId", "actorUserId", "at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_action_at_idx" ON "AuditLog"("workspaceId", "action", "at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_assigneeId_status_dueAt_idx" ON "Task"("workspaceId", "assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_dueAt_idx" ON "Task"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_recordId_idx" ON "Task"("workspaceId", "recordId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_conversationId_idx" ON "Task"("workspaceId", "conversationId");

-- CreateIndex
CREATE INDEX "Task_assigneeId_idx" ON "Task"("assigneeId");

-- CreateIndex
CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");

-- CreateIndex
CREATE INDEX "Task_recordId_idx" ON "Task"("recordId");

-- CreateIndex
CREATE INDEX "Task_conversationId_idx" ON "Task"("conversationId");

-- CreateIndex
CREATE INDEX "Note_workspaceId_recordId_createdAt_idx" ON "Note"("workspaceId", "recordId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Note_workspaceId_conversationId_createdAt_idx" ON "Note"("workspaceId", "conversationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Note_recordId_idx" ON "Note"("recordId");

-- CreateIndex
CREATE INDEX "Note_conversationId_idx" ON "Note"("conversationId");

-- CreateIndex
CREATE INDEX "Note_authorId_idx" ON "Note"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_prefix_idx" ON "ApiKey"("workspaceId", "prefix");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_revokedAt_idx" ON "ApiKey"("workspaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "ApiKey_createdById_idx" ON "ApiKey"("createdById");

-- CreateIndex
CREATE INDEX "OutboundWebhookSubscription_workspaceId_enabled_idx" ON "OutboundWebhookSubscription"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "OutboundWebhookSubscription_createdById_idx" ON "OutboundWebhookSubscription"("createdById");

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_workspaceId_subscriptionId_createdA_idx" ON "OutboundWebhookDelivery"("workspaceId", "subscriptionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_workspaceId_status_nextAttemptAt_idx" ON "OutboundWebhookDelivery"("workspaceId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundWebhookDelivery_subscriptionId_idx" ON "OutboundWebhookDelivery"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundWebhookDelivery_workspaceId_subscriptionId_idempote_key" ON "OutboundWebhookDelivery"("workspaceId", "subscriptionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_workspaceId_status_dueAt_idx" ON "DataSubjectRequest"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_workspaceId_subjectEmail_idx" ON "DataSubjectRequest"("workspaceId", "subjectEmail");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_subjectRecordId_idx" ON "DataSubjectRequest"("subjectRecordId");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_requestedById_idx" ON "DataSubjectRequest"("requestedById");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectType" ADD CONSTRAINT "ObjectType_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attribute" ADD CONSTRAINT "Attribute_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attribute" ADD CONSTRAINT "Attribute_objectTypeId_fkey" FOREIGN KEY ("objectTypeId") REFERENCES "ObjectType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_objectTypeId_fkey" FOREIGN KEY ("objectTypeId") REFERENCES "ObjectType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordRelation" ADD CONSTRAINT "RecordRelation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordRelation" ADD CONSTRAINT "RecordRelation_fromRecordId_fkey" FOREIGN KEY ("fromRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordRelation" ADD CONSTRAINT "RecordRelation_toRecordId_fkey" FOREIGN KEY ("toRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordRelation" ADD CONSTRAINT "RecordRelation_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "List" ADD CONSTRAINT "List_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "List" ADD CONSTRAINT "List_objectTypeId_fkey" FOREIGN KEY ("objectTypeId") REFERENCES "ObjectType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListAttribute" ADD CONSTRAINT "ListAttribute_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListAttribute" ADD CONSTRAINT "ListAttribute_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListEntry" ADD CONSTRAINT "ListEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListEntry" ADD CONSTRAINT "ListEntry_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListEntry" ADD CONSTRAINT "ListEntry_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListStageHistory" ADD CONSTRAINT "ListStageHistory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListStageHistory" ADD CONSTRAINT "ListStageHistory_listEntryId_fkey" FOREIGN KEY ("listEntryId") REFERENCES "ListEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListStageHistory" ADD CONSTRAINT "ListStageHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_objectTypeId_fkey" FOREIGN KEY ("objectTypeId") REFERENCES "ObjectType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributePermission" ADD CONSTRAINT "AttributePermission_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributePermission" ADD CONSTRAINT "AttributePermission_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_personRecordId_fkey" FOREIGN KEY ("personRecordId") REFERENCES "Record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_personRecordId_fkey" FOREIGN KEY ("personRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeSuggestion" ADD CONSTRAINT "MergeSuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeSuggestion" ADD CONSTRAINT "MergeSuggestion_leftRecordId_fkey" FOREIGN KEY ("leftRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeSuggestion" ADD CONSTRAINT "MergeSuggestion_rightRecordId_fkey" FOREIGN KEY ("rightRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeSuggestion" ADD CONSTRAINT "MergeSuggestion_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NeverMerge" ADD CONSTRAINT "NeverMerge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NeverMerge" ADD CONSTRAINT "NeverMerge_leftRecordId_fkey" FOREIGN KEY ("leftRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NeverMerge" ADD CONSTRAINT "NeverMerge_rightRecordId_fkey" FOREIGN KEY ("rightRecordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NeverMerge" ADD CONSTRAINT "NeverMerge_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordMerge" ADD CONSTRAINT "RecordMerge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordMerge" ADD CONSTRAINT "RecordMerge_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordMerge" ADD CONSTRAINT "RecordMerge_loserId_fkey" FOREIGN KEY ("loserId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordMerge" ADD CONSTRAINT "RecordMerge_mergedById_fkey" FOREIGN KEY ("mergedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordMerge" ADD CONSTRAINT "RecordMerge_unmergedById_fkey" FOREIGN KEY ("unmergedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_personRecordId_fkey" FOREIGN KEY ("personRecordId") REFERENCES "Record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorIdentityId_fkey" FOREIGN KEY ("authorIdentityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_outboundActionId_fkey" FOREIGN KEY ("outboundActionId") REFERENCES "OutboundAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_actorIdentityId_fkey" FOREIGN KEY ("actorIdentityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_externalObjectId_fkey" FOREIGN KEY ("externalObjectId") REFERENCES "ExternalObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_fieldMappingId_fkey" FOREIGN KEY ("fieldMappingId") REFERENCES "FieldMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionGrant" ADD CONSTRAINT "ConnectionGrant_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncCursor" ADD CONSTRAINT "SyncCursor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncCursor" ADD CONSTRAINT "SyncCursor_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalObject" ADD CONSTRAINT "ExternalObject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalObject" ADD CONSTRAINT "ExternalObject_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateBudget" ADD CONSTRAINT "RateBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateBudget" ADD CONSTRAINT "RateBudget_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAction" ADD CONSTRAINT "OutboundAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAction" ADD CONSTRAINT "OutboundAction_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAction" ADD CONSTRAINT "OutboundAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAction" ADD CONSTRAINT "OutboundAction_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAction" ADD CONSTRAINT "OutboundAction_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationError" ADD CONSTRAINT "IntegrationError_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationError" ADD CONSTRAINT "IntegrationError_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationError" ADD CONSTRAINT "IntegrationError_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationError" ADD CONSTRAINT "IntegrationError_externalObjectId_fkey" FOREIGN KEY ("externalObjectId") REFERENCES "ExternalObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationError" ADD CONSTRAINT "IntegrationError_outboundActionId_fkey" FOREIGN KEY ("outboundActionId") REFERENCES "OutboundAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationError" ADD CONSTRAINT "IntegrationError_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionDriftSample" ADD CONSTRAINT "ConnectionDriftSample_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionDriftSample" ADD CONSTRAINT "ConnectionDriftSample_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldMapping" ADD CONSTRAINT "FieldMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldMappingRule" ADD CONSTRAINT "FieldMappingRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldMappingRule" ADD CONSTRAINT "FieldMappingRule_fieldMappingId_fkey" FOREIGN KEY ("fieldMappingId") REFERENCES "FieldMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldMappingRule" ADD CONSTRAINT "FieldMappingRule_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "Attribute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Embedding" ADD CONSTRAINT "Embedding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhookSubscription" ADD CONSTRAINT "OutboundWebhookSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhookSubscription" ADD CONSTRAINT "OutboundWebhookSubscription_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhookDelivery" ADD CONSTRAINT "OutboundWebhookDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundWebhookDelivery" ADD CONSTRAINT "OutboundWebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OutboundWebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_subjectRecordId_fkey" FOREIGN KEY ("subjectRecordId") REFERENCES "Record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- nexus:managed-outside-schema
--
-- Everything below this marker is hand-written: Prisma cannot express these
-- objects in schema.prisma. Each one is listed in prisma/drift-allowlist.json
-- so the §15 drift gate (`pnpm --filter @nexus/db drift`) ignores it. The
-- statements above this marker are the verbatim output of
--   prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- and must not be edited by hand.
-- =============================================================================

-- Extensions are declared on the datasource and already created above; these
-- guards only make this section safe to re-run in isolation.
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";

-- Record.values: jsonb_path_ops GIN so `values @> '{...}'` containment filters
-- hit an index (§6.2 hybrid storage rule). Hot attributes additionally get a
-- generated btree column via the index.build job; those columns and indexes are
-- matched by the `patterns` in prisma/drift-allowlist.json.
CREATE INDEX "record_values_gin" ON "Record" USING GIN ("values" jsonb_path_ops);

-- Record.searchVector: full-text search.
CREATE INDEX "record_search_vector_gin" ON "Record" USING GIN ("searchVector");

-- Semantic search (cosine distance). HNSW rather than ivfflat: no training
-- step, so it works from an empty table and stays accurate as data grows.
CREATE INDEX "record_embedding_hnsw" ON "Record" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "embedding_vector_hnsw" ON "Embedding" USING hnsw ("vector" vector_cosine_ops);

-- Trigram indexes for fuzzy handle / display-name matching (§10 HANDLE_MATCH, NAME_FUZZY).
CREATE INDEX "identity_handle_trgm" ON "Identity" USING GIN ("handle" gin_trgm_ops);
CREATE INDEX "identity_display_name_trgm" ON "Identity" USING GIN ("displayName" gin_trgm_ops);

-- Row Level Security helper (§5.1). Reads the tenant set per transaction with
--   SET LOCAL app.workspace_id = '<uuid>';
-- Returns NULL when unset, so a policy `"workspaceId" = nexus_current_workspace()::text`
-- denies by default. Only the helper ships in this migration: the policies
-- (ALTER TABLE … ENABLE ROW LEVEL SECURITY + CREATE POLICY rls_<table>_tenant on
-- every tenant table) are Phase 1, landing together with withTenant().
CREATE OR REPLACE FUNCTION nexus_current_workspace() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid;
$$;
