-- CreateEnum
CREATE TYPE "VaultKind" AS ENUM ('OAUTH_TOKEN', 'API_KEY', 'WEBHOOK_SECRET', 'SIGNING_SECRET');

-- CreateTable
CREATE TABLE "WorkspaceKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "masterKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaultEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "VaultKind" NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "errorClass" "IntegrationErrorClass" NOT NULL DEFAULT 'UNKNOWN',
    "errorCode" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMP(3),
    "replayJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceKey_workspaceId_keyVersion_key" ON "WorkspaceKey"("workspaceId", "keyVersion");

-- CreateIndex
CREATE INDEX "VaultEntry_workspaceId_kind_idx" ON "VaultEntry"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "VaultEntry_keyId_idx" ON "VaultEntry"("keyId");

-- CreateIndex
CREATE INDEX "DeadLetter_workspaceId_replayedAt_failedAt_idx" ON "DeadLetter"("workspaceId", "replayedAt", "failedAt" DESC);

-- CreateIndex
CREATE INDEX "DeadLetter_connectionId_idx" ON "DeadLetter"("connectionId");

-- AddForeignKey
ALTER TABLE "WorkspaceKey" ADD CONSTRAINT "WorkspaceKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultEntry" ADD CONSTRAINT "VaultEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultEntry" ADD CONSTRAINT "VaultEntry_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "WorkspaceKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetter" ADD CONSTRAINT "DeadLetter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetter" ADD CONSTRAINT "DeadLetter_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
