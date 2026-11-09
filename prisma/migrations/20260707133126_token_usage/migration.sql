-- CreateTable
CREATE TABLE "TokenUsage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT,
    "agentId" TEXT,
    "userId" TEXT,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenUsage_companyId_createdAt_idx" ON "TokenUsage"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenUsage_companyId_agentId_idx" ON "TokenUsage"("companyId", "agentId");

-- CreateIndex
CREATE INDEX "TokenUsage_companyId_userId_idx" ON "TokenUsage"("companyId", "userId");
