-- CreateEnum
CREATE TYPE "ConversationVisibility" AS ENUM ('PRIVATE', 'COMPANY', 'USERS');

-- CreateEnum
CREATE TYPE "ShareRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "visibility" "ConversationVisibility" NOT NULL DEFAULT 'PRIVATE';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationShareRequest" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "ShareRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationShareRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "ConversationShareRequest_requesterId_idx" ON "ConversationShareRequest"("requesterId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationShareRequest_conversationId_requesterId_key" ON "ConversationShareRequest"("conversationId", "requesterId");

-- CreateIndex
CREATE INDEX "Conversation_companyId_userId_idx" ON "Conversation"("companyId", "userId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationShareRequest" ADD CONSTRAINT "ConversationShareRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationShareRequest" ADD CONSTRAINT "ConversationShareRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
