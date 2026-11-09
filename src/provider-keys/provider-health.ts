/**
 * Provedores que falharam há pouco ficam "fora" por um tempo: as mensagens
 * seguintes vão direto para a reserva em vez de esperar o provedor morto falhar
 * de novo a cada turno. Passado o prazo, o provedor volta a ser tentado.
 *
 * atalho: em memória, vale para uma réplica da api; com réplicas, mover para o Redis.
 */
const DOWN_MS = 60_000;
const downUntil = new Map<string, number>();

/** Identidade de um provedor na cadeia: empresa + provedor + fim da chave. */
export function providerHealthKey(
  companyId: string,
  provider: string,
  apiKey: string,
) {
  return `${companyId}|${provider.toLowerCase()}|${apiKey ? apiKey.slice(-8) : 'assinatura'}`;
}

export function markProviderDown(key: string, ms = DOWN_MS) {
  downUntil.set(key, Date.now() + ms);
}

export function markProviderUp(key: string) {
  downUntil.delete(key);
}

export function isProviderDown(key: string) {
  const until = downUntil.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  downUntil.delete(key);
  return false;
}

/** Mantém a ordem, mas manda os que estão fora para o fim (último recurso). */
export function orderByHealth<T>(chain: T[], keyOf: (item: T) => string): T[] {
  const up = chain.filter((p) => !isProviderDown(keyOf(p)));
  const down = chain.filter((p) => isProviderDown(keyOf(p)));
  return [...up, ...down];
}
