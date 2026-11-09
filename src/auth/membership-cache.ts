import type { UserRole } from '@prisma/client';

/**
 * Papel de cada pessoa na org, lido pelo OrgGuard a cada requisição. Quem
 * altera o vínculo (promover, remover, entrar por convite) chama
 * forgetMembership para valer na hora, sem esperar o TTL.
 */
// atalho: cache em memória da instância; com várias réplicas da api, a mudança vale na hora só na réplica que a fez (nas outras, em até 30 s) — mover para o Redis se houver réplicas.
export const membershipCache = new Map<
  string,
  { role: UserRole | null; expires: number }
>();

export const membershipKey = (userId: string, companyId: string) =>
  `${userId}:${companyId}`;

export function forgetMembership(userId: string, companyId: string) {
  membershipCache.delete(membershipKey(userId, companyId));
}
