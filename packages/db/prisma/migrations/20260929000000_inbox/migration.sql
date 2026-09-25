-- Phase 7: the unified inbox (spec §12.2.A). Triage tags and the SLA clock on
-- conversations, deep links on messages, and saved (canned) replies for the composer.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Conversation" ADD COLUMN "firstResponseAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_slaDueAt_idx" ON "Conversation"("workspaceId", "slaDueAt");

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "sourceUrl" TEXT;

-- CreateTable
CREATE TABLE "CannedReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "shortcut" TEXT,
    "platform" "Platform",
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CannedReply_workspaceId_shortcut_key" ON "CannedReply"("workspaceId", "shortcut");
CREATE INDEX "CannedReply_workspaceId_platform_idx" ON "CannedReply"("workspaceId", "platform");
CREATE INDEX "CannedReply_createdById_idx" ON "CannedReply"("createdById");

-- AddForeignKey
ALTER TABLE "CannedReply" ADD CONSTRAINT "CannedReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CannedReply" ADD CONSTRAINT "CannedReply_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- nexus:managed-outside-schema
-- Row-level security for the new tenant table (same policy shape as scripts/gen-rls-sql.ts).
ALTER TABLE "CannedReply" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CannedReply" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_CannedReply_tenant ON "CannedReply";
CREATE POLICY rls_CannedReply_tenant ON "CannedReply"
  USING ("workspaceId" = nexus_current_workspace() OR nexus_rls_bypass())
  WITH CHECK ("workspaceId" = nexus_current_workspace() OR nexus_rls_bypass());

-- Application role privileges (only when the role exists in this cluster).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "CannedReply" TO nexus_app';
  END IF;
END $$;
