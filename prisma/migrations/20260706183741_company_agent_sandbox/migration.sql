-- CreateEnum
CREATE TYPE "AgentSandbox" AS ENUM ('WORKSPACE', 'CUSTOM', 'FREE');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "agentSandbox" "AgentSandbox" NOT NULL DEFAULT 'WORKSPACE',
ADD COLUMN     "sandboxPath" TEXT;
