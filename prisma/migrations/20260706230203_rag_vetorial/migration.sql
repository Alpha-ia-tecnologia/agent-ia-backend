-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "embeddingKeyId" TEXT,
ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeChunk" ADD COLUMN     "embedding" vector,
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "tsv" tsvector;

-- AlterTable
ALTER TABLE "KnowledgeDocument" ADD COLUMN     "embeddedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_embeddingKeyId_fkey" FOREIGN KEY ("embeddingKeyId") REFERENCES "ProviderKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- tsv mantida por trigger (coluna GENERATED não é representável no Prisma e
-- seria droppada por drift de novo)
CREATE OR REPLACE FUNCTION knowledge_chunk_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."tsv" := to_tsvector('portuguese', NEW."content");
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_chunk_tsv_trigger
  BEFORE INSERT OR UPDATE OF "content" ON "KnowledgeChunk"
  FOR EACH ROW EXECUTE FUNCTION knowledge_chunk_tsv_update();

-- Backfill dos chunks existentes
UPDATE "KnowledgeChunk" SET "tsv" = to_tsvector('portuguese', "content");
