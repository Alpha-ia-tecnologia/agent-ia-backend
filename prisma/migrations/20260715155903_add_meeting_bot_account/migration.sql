-- CreateTable
CREATE TABLE "MeetingBotAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT,
    "encryptedState" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastValidatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "MeetingBotAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingBotAccount_companyId_provider_status_idx" ON "MeetingBotAccount"("companyId", "provider", "status");

-- AddForeignKey
ALTER TABLE "MeetingBotAccount" ADD CONSTRAINT "MeetingBotAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
