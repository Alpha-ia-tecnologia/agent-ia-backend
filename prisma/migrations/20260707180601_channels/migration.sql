-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "encryptedToken" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelContact" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Channel_companyId_idx" ON "Channel"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelContact_conversationId_key" ON "ChannelContact"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelContact_channelId_externalId_key" ON "ChannelContact"("channelId", "externalId");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelContact" ADD CONSTRAINT "ChannelContact_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
