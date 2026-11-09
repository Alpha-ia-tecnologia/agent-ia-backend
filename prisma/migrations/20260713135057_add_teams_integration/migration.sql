-- CreateTable
CREATE TABLE "TeamsConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "msTenantId" TEXT NOT NULL,
    "encryptedToken" TEXT,
    "iv" TEXT,
    "authTag" TEXT,
    "consentGrantedBy" TEXT NOT NULL DEFAULT '',
    "subscriptionId" TEXT,
    "subscriptionExpires" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsMeeting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "msMeetingId" TEXT NOT NULL,
    "msTranscriptId" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "organizerEmail" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "conversationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamsMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamsConnection_companyId_key" ON "TeamsConnection"("companyId");

-- CreateIndex
CREATE INDEX "TeamsConnection_msTenantId_idx" ON "TeamsConnection"("msTenantId");

-- CreateIndex
CREATE INDEX "TeamsMeeting_companyId_status_idx" ON "TeamsMeeting"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TeamsMeeting_companyId_msMeetingId_key" ON "TeamsMeeting"("companyId", "msMeetingId");

-- AddForeignKey
ALTER TABLE "TeamsConnection" ADD CONSTRAINT "TeamsConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamsMeeting" ADD CONSTRAINT "TeamsMeeting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
