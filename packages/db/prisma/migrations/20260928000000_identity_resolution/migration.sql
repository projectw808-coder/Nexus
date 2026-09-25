-- Phase 6: identity resolution (spec §10, ADR-017).
-- A MergeSuggestion is either a record↔record pair or an unresolved identity proposed for a
-- person; TimelineEvent gains an idempotency key; Identity remembers its last resolver pass.

-- AlterTable
ALTER TABLE "MergeSuggestion" ALTER COLUMN "leftRecordId" DROP NOT NULL;
ALTER TABLE "MergeSuggestion" ADD COLUMN "identityId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MergeSuggestion_workspaceId_identityId_rightRecordId_key" ON "MergeSuggestion"("workspaceId", "identityId", "rightRecordId");
CREATE INDEX "MergeSuggestion_identityId_idx" ON "MergeSuggestion"("identityId");

-- AddForeignKey
ALTER TABLE "MergeSuggestion" ADD CONSTRAINT "MergeSuggestion_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Identity" ADD COLUMN "resolutionAttemptedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Identity_workspaceId_personRecordId_resolutionAttemptedAt_idx" ON "Identity"("workspaceId", "personRecordId", "resolutionAttemptedAt");

-- AlterTable
ALTER TABLE "TimelineEvent" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEvent_workspaceId_dedupeKey_key" ON "TimelineEvent"("workspaceId", "dedupeKey");
