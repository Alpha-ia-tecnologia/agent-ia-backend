-- CreateEnum
CREATE TYPE "HttpMethod" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE');

-- AlterTable
ALTER TABLE "OrchestrationEvent" ALTER COLUMN "conversationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CustomTool" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "method" "HttpMethod" NOT NULL,
    "url" TEXT NOT NULL,
    "encryptedHeaders" TEXT,
    "headersIv" TEXT,
    "headersAuthTag" TEXT,
    "paramsSchema" JSONB NOT NULL,
    "timeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTool" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,

    CONSTRAINT "AgentTool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomTool_companyId_name_key" ON "CustomTool"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTool_agentId_toolId_key" ON "AgentTool"("agentId", "toolId");

-- AddForeignKey
ALTER TABLE "CustomTool" ADD CONSTRAINT "CustomTool_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTool" ADD CONSTRAINT "AgentTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "CustomTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
