-- Phase 9: a rejected webhook carries its remediation string (spec §9.2) so the delivery log
-- can show it without recomputing anything.

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN "remediation" TEXT;
