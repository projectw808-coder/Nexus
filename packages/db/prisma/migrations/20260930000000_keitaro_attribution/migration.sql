-- Phase 8: Keitaro's attribution ledger (spec §8.6, ADR-019). One row per
-- (connectionId, subid, tid) so a conversion's repeated lead -> sale -> rejected
-- postbacks apply and reverse Deal revenue exactly once each, never a recomputation.

-- CreateTable
CREATE TABLE "KeitaroConversionState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "subid" TEXT NOT NULL,
    "tid" TEXT NOT NULL,
    "dealRecordId" TEXT,
    "lastConversionExternalId" TEXT NOT NULL,
    "lastStatus" TEXT NOT NULL,
    "appliedPayoutCents" INTEGER NOT NULL DEFAULT 0,
    "appliedCurrency" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "KeitaroConversionState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KeitaroConversionState_workspaceId_connectionId_subid_tid_key" ON "KeitaroConversionState"("workspaceId", "connectionId", "subid", "tid");
CREATE INDEX "KeitaroConversionState_workspaceId_dealRecordId_idx" ON "KeitaroConversionState"("workspaceId", "dealRecordId");
CREATE INDEX "KeitaroConversionState_connectionId_idx" ON "KeitaroConversionState"("connectionId");

-- AddForeignKey
ALTER TABLE "KeitaroConversionState" ADD CONSTRAINT "KeitaroConversionState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KeitaroConversionState" ADD CONSTRAINT "KeitaroConversionState_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KeitaroConversionState" ADD CONSTRAINT "KeitaroConversionState_dealRecordId_fkey" FOREIGN KEY ("dealRecordId") REFERENCES "Record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- nexus:managed-outside-schema
-- Row-level security for the new tenant table (same policy shape as scripts/gen-rls-sql.ts).
ALTER TABLE "KeitaroConversionState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KeitaroConversionState" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_KeitaroConversionState_tenant ON "KeitaroConversionState";
CREATE POLICY rls_KeitaroConversionState_tenant ON "KeitaroConversionState"
  USING ("workspaceId" = nexus_current_workspace() OR nexus_rls_bypass())
  WITH CHECK ("workspaceId" = nexus_current_workspace() OR nexus_rls_bypass());

-- Application role privileges (only when the role exists in this cluster).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "KeitaroConversionState" TO nexus_app';
  END IF;
END $$;
