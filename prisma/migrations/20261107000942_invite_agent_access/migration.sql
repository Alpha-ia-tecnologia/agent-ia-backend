-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "allAgents" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "managerAccess" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "OrgInvite" ADD COLUMN     "agentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "allAgents" BOOLEAN NOT NULL DEFAULT true;
