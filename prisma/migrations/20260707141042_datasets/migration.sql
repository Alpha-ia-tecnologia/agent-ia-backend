-- CreateEnum
CREATE TYPE "DatasetColumnType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'CURRENCY');

-- CreateEnum
CREATE TYPE "DatasetQuality" AS ENUM ('OK', 'WITH_ISSUES');

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'UPLOAD',
    "fileName" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "quality" "DatasetQuality" NOT NULL DEFAULT 'OK',
    "qualityNotes" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetColumn" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DatasetColumnType" NOT NULL DEFAULT 'TEXT',
    "description" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,

    CONSTRAINT "DatasetColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetRow" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "DatasetRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dataset_companyId_idx" ON "Dataset"("companyId");

-- CreateIndex
CREATE INDEX "DatasetColumn_datasetId_idx" ON "DatasetColumn"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetColumn_datasetId_name_key" ON "DatasetColumn"("datasetId", "name");

-- CreateIndex
CREATE INDEX "DatasetRow_datasetId_rowIndex_idx" ON "DatasetRow"("datasetId", "rowIndex");

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetColumn" ADD CONSTRAINT "DatasetColumn_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetRow" ADD CONSTRAINT "DatasetRow_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
