/*
  Warnings:

  - You are about to drop the column `tsv` on the `KnowledgeChunk` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "KnowledgeChunk_tsv_idx";

-- AlterTable
ALTER TABLE "KnowledgeChunk" DROP COLUMN "tsv";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "departmentId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
