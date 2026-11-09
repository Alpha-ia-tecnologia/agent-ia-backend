/*
  Warnings:

  - You are about to drop the `TeamsConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TeamsMeeting` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "TeamsConnection" DROP CONSTRAINT "TeamsConnection_companyId_fkey";

-- DropForeignKey
ALTER TABLE "TeamsMeeting" DROP CONSTRAINT "TeamsMeeting_companyId_fkey";

-- DropTable
DROP TABLE "TeamsConnection";

-- DropTable
DROP TABLE "TeamsMeeting";
