-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('PROCESSING', 'READY', 'ERROR');

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "agentId" TEXT,
    "title" TEXT NOT NULL,
    "objectName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDocument_companyId_idx" ON "KnowledgeDocument"("companyId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_companyId_idx" ON "KnowledgeChunk"("companyId");

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Busca lexical em português (base do RAG; vetorial via pgvector entra depois)
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "KnowledgeChunk"
  ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', "content")) STORED;
CREATE INDEX "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");
