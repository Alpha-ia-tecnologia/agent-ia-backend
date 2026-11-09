import { Prisma, UserRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Quais agentes uma pessoa pode ver e acionar numa org. OWNER/ADMIN: todos.
 * MEMBER: depende de como entrou — convite "todos os agentes" (allAgents),
 * convite restrito (só os escolhidos, sem o Gerente) ou o jeito antigo
 * (Gerente + liberados). Um lugar só para a listagem e para o chat.
 */
export interface AgentScope {
  all: boolean;
  manager: boolean;
}

export async function agentScope(
  prisma: PrismaService,
  userId: string,
  companyId: string,
): Promise<AgentScope> {
  const m = await prisma.membership.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { role: true, allAgents: true, managerAccess: true },
  });
  if (!m) return { all: false, manager: false };
  if (m.role !== UserRole.MEMBER || m.allAgents) {
    return { all: true, manager: true };
  }
  return { all: false, manager: m.managerAccess };
}

/** Filtro de `agent.findMany` com o que a pessoa pode ver. */
export function agentScopeFilter(
  userId: string,
  scope: AgentScope,
): Prisma.AgentWhereInput {
  if (scope.all) return {};
  const liberated: Prisma.AgentWhereInput = {
    userAccess: { some: { userId } },
  };
  return scope.manager ? { OR: [{ isManager: true }, liberated] } : liberated;
}

export async function canUseAgent(
  prisma: PrismaService,
  userId: string,
  companyId: string,
  agentId: string,
): Promise<boolean> {
  const scope = await agentScope(prisma, userId, companyId);
  const found = await prisma.agent.findFirst({
    where: { id: agentId, companyId, ...agentScopeFilter(userId, scope) },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Agente de uma mensagem sem agente escolhido: o Gerente, se a pessoa tem
 * acesso a ele; senão o primeiro agente liberado (convite restrito).
 */
export async function pickDefaultAgent(
  prisma: PrismaService,
  userId: string,
  companyId: string,
) {
  const scope = await agentScope(prisma, userId, companyId);
  return prisma.agent.findFirst({
    where: { companyId, isActive: true, ...agentScopeFilter(userId, scope) },
    orderBy: [{ isManager: 'desc' }, { createdAt: 'asc' }],
  });
}
