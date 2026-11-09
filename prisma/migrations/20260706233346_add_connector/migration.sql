-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "folders" JSONB NOT NULL DEFAULT '[]',
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Connector_tokenHash_key" ON "Connector"("tokenHash");

-- CreateIndex
CREATE INDEX "Connector_companyId_idx" ON "Connector"("companyId");

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
