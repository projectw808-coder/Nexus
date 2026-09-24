-- CreateEnum
CREATE TYPE "IndexState" AS ENUM ('NONE', 'BUILDING', 'READY', 'FAILED', 'DROPPING');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PREVIEW', 'RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK');

-- AlterTable
ALTER TABLE "Attribute" ADD COLUMN     "indexError" TEXT,
ADD COLUMN     "indexProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "indexState" "IndexState" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "purgeAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Record" ADD COLUMN     "importJobId" TEXT;

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "objectTypeId" TEXT NOT NULL,
    "createdById" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "fileName" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT ',',
    "sourceText" TEXT NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_workspaceId_objectTypeId_createdAt_idx" ON "ImportJob"("workspaceId", "objectTypeId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ImportJob_objectTypeId_idx" ON "ImportJob"("objectTypeId");

-- CreateIndex
CREATE INDEX "ImportJob_createdById_idx" ON "ImportJob"("createdById");

-- CreateIndex
CREATE INDEX "Record_workspaceId_importJobId_idx" ON "Record"("workspaceId", "importJobId");

-- CreateIndex
CREATE INDEX "Record_importJobId_idx" ON "Record"("importJobId");

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_objectTypeId_fkey" FOREIGN KEY ("objectTypeId") REFERENCES "ObjectType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- nexus:managed-outside-schema
-- Search and generated-column support for the object graph (§6.2, ADR-009). Prisma cannot
-- express functions, triggers or expression indexes; they are allowlisted in drift-allowlist.json.

-- Concatenate every string leaf of a JSONB document (record values keyed by attribute id).
CREATE OR REPLACE FUNCTION nexus_jsonb_text(doc jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT COALESCE(string_agg(v, ' '), '')
    FROM jsonb_path_query(doc, 'strict $.** ? (@.type() == "string")') AS t(j)
    CROSS JOIN LATERAL (SELECT j #>> '{}' AS v) AS x
  $$;

-- Immutable extraction wrappers for generated btree columns (NULL on unparsable input).
CREATE OR REPLACE FUNCTION nexus_immutable_numeric(t text) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$ BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION nexus_immutable_timestamptz(t text) RETURNS timestamptz
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$ BEGIN RETURN t::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION nexus_immutable_boolean(t text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$ BEGIN RETURN t::boolean; EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- Full-text vector kept current by trigger; trigram index on the flattened text for substring search.
CREATE OR REPLACE FUNCTION nexus_record_search_sync() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW."searchVector" := to_tsvector('simple', nexus_jsonb_text(NEW."values"));
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS record_search_sync ON "Record";
CREATE TRIGGER record_search_sync
  BEFORE INSERT OR UPDATE OF "values" ON "Record"
  FOR EACH ROW EXECUTE FUNCTION nexus_record_search_sync();

CREATE INDEX IF NOT EXISTS record_values_text_trgm
  ON "Record" USING gin (nexus_jsonb_text("values") gin_trgm_ops);
