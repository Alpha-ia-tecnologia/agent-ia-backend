-- AlterTable
ALTER TABLE "OrchestrationEvent" ADD COLUMN     "companyId" TEXT;

-- CreateIndex
CREATE INDEX "OrchestrationEvent_companyId_createdAt_idx" ON "OrchestrationEvent"("companyId", "createdAt");

-- Backfill: companyId dos eventos ligados a conversas
UPDATE "OrchestrationEvent" e
SET "companyId" = c."companyId"
FROM "Conversation" c
WHERE e."conversationId" = c."id" AND e."companyId" IS NULL;
