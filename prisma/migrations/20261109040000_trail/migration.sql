-- CreateTable
CREATE TABLE "TrailEvent" (
    "companyId" TEXT NOT NULL,
    "releasedUpTo" INTEGER NOT NULL DEFAULT 0,
    "entryOpen" BOOLEAN NOT NULL DEFAULT false,
    "pilotOpen" BOOLEAN NOT NULL DEFAULT false,
    "voteOpen" BOOLEAN NOT NULL DEFAULT false,
    "chegadaOpen" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrailEvent_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "TrailRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "releasedUpTo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrailRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailMember" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "department" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrailMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "station" INTEGER NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrailResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailSession" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "station" INTEGER NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "phase" TEXT NOT NULL DEFAULT 'answer',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "documentId" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrailSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "authorName" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailNote" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "station" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "department" TEXT,
    "step" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrailNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailPilot" (
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "chosen" INTEGER,
    "sheet" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrailPilot_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "TrailPlan" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "content" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrailPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailPilotVote" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "station" INTEGER NOT NULL,

    CONSTRAINT "TrailPilotVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrailPublicVote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,

    CONSTRAINT "TrailPublicVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrailRun_companyId_number_key" ON "TrailRun"("companyId", "number");

-- CreateIndex
CREATE INDEX "TrailMember_runId_idx" ON "TrailMember"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "TrailMember_userId_companyId_key" ON "TrailMember"("userId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "TrailResult_runId_station_key" ON "TrailResult"("runId", "station");

-- CreateIndex
CREATE INDEX "TrailSession_runId_station_idx" ON "TrailSession"("runId", "station");

-- CreateIndex
CREATE UNIQUE INDEX "TrailSession_runId_userId_station_key" ON "TrailSession"("runId", "userId", "station");

-- CreateIndex
CREATE INDEX "TrailMessage_sessionId_createdAt_idx" ON "TrailMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "TrailNote_runId_station_createdAt_idx" ON "TrailNote"("runId", "station", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrailNote_runId_userId_station_step_key" ON "TrailNote"("runId", "userId", "station", "step");

-- CreateIndex
CREATE INDEX "TrailPlan_runId_idx" ON "TrailPlan"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "TrailPlan_runId_userId_key" ON "TrailPlan"("runId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrailPilotVote_runId_userId_key" ON "TrailPilotVote"("runId", "userId");

-- CreateIndex
CREATE INDEX "TrailPublicVote_runId_idx" ON "TrailPublicVote"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "TrailPublicVote_companyId_userId_key" ON "TrailPublicVote"("companyId", "userId");

-- AddForeignKey
ALTER TABLE "TrailEvent" ADD CONSTRAINT "TrailEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailRun" ADD CONSTRAINT "TrailRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailMember" ADD CONSTRAINT "TrailMember_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailMember" ADD CONSTRAINT "TrailMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailResult" ADD CONSTRAINT "TrailResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailSession" ADD CONSTRAINT "TrailSession_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailSession" ADD CONSTRAINT "TrailSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailMessage" ADD CONSTRAINT "TrailMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TrailSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailNote" ADD CONSTRAINT "TrailNote_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailPilot" ADD CONSTRAINT "TrailPilot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailPlan" ADD CONSTRAINT "TrailPlan_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailPlan" ADD CONSTRAINT "TrailPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailPilotVote" ADD CONSTRAINT "TrailPilotVote_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailPilot"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrailPublicVote" ADD CONSTRAINT "TrailPublicVote_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TrailRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

