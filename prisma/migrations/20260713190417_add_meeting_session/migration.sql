-- CreateTable
CREATE TABLE "MeetingSession" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'TEAMS',
    "joinUrl" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "botWorkerId" TEXT,
    "startedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "recordingKey" TEXT,
    "transcriptKey" TEXT,
    "highlights" JSONB,
    "conversationId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingSession_companyId_status_idx" ON "MeetingSession"("companyId", "status");

-- CreateIndex
CREATE INDEX "MeetingSession_scheduledAt_idx" ON "MeetingSession"("scheduledAt");

-- AddForeignKey
ALTER TABLE "MeetingSession" ADD CONSTRAINT "MeetingSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
