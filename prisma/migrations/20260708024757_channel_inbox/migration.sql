-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "autoRespond" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ChannelContact" ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelMessage_contactId_createdAt_idx" ON "ChannelMessage"("contactId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ChannelContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
