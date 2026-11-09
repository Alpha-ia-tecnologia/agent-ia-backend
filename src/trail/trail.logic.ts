export const TOTAL_STATIONS = 5;
export const LARGADA = 0;
/** Etapa final e individual: 1 dor, 1 dado, 1 dono e o plano de 90 dias. */
export const CHEGADA = TOTAL_STATIONS + 1;
export const MAX_ROOM_SIZE = 11;
/** Na última tentativa o Guia complementa e a pessoa segue em frente. */
export const MAX_STEP_ATTEMPTS = 2;

export const isStation = (n: number, total = TOTAL_STATIONS) =>
  n >= 1 && n <= total;

/** Primeira estação ainda não concluída (TOTAL + 1 se todas foram). */
export function firstPending(done: number[], total = TOTAL_STATIONS): number {
  for (let n = 1; n <= total; n++) {
    if (!done.includes(n)) return n;
  }
  return total + 1;
}

/**
 * Até qual estação a pessoa pode abrir: a primeira que ela ainda não concluiu,
 * ou o que o organizador liberou. Antes da Largada, só o que foi liberado.
 */
export function maxOpenStation(
  done: number[],
  runReleased: number,
  roomReleased: number,
  largadaDone = true,
  total = TOTAL_STATIONS,
): number {
  return Math.min(
    total,
    Math.max(
      largadaDone ? firstPending(done, total) : 0,
      runReleased,
      roomReleased,
    ),
  );
}

/** A mesa ganha a medalha quando metade dela conclui a estação. */
export function tableQuorum(members: number): number {
  return Math.max(1, Math.ceil(members / 2));
}

/** Ideia mais votada; no empate, a da estação que veio primeiro. */
export function winningStation(votes: number[], stations: number[]) {
  let best: number | null = null;
  let bestCount = 0;
  for (const station of [...stations].sort((a, b) => a - b)) {
    const count = votes.filter((v) => v === station).length;
    if (count > bestCount) {
      best = station;
      bestCount = count;
    }
  }
  return best;
}

/** Especialista escolhido pelo Guia, se for um dos permitidos. */
export function parseRoute(raw: string, allowed: string[]): string | null {
  try {
    const { agente } = JSON.parse(raw) as { agente?: unknown };
    return typeof agente === 'string' && allowed.includes(agente)
      ? agente
      : null;
  } catch {
    return null;
  }
}

export interface ParsedTurn {
  resolved: boolean;
  message: string;
  options: string[];
  note: string;
  idea: string;
}

const MAX_OPTIONS = 4;
const MAX_OPTION_CHARS = 60;

const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : '';

/** Resposta da IA: mensagem, respostas sugeridas e o que vai para o mural. */
export function parseTurn(raw: string): ParsedTurn | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const message = text(data.mensagem);
    if (!message) return null;
    const options = Array.isArray(data.opcoes) ? data.opcoes : [];
    return {
      resolved: data.resolvido === true,
      message,
      options: options
        .map(text)
        .filter((o) => o && o.length <= MAX_OPTION_CHARS)
        .slice(0, MAX_OPTIONS),
      note: text(data.nota),
      idea: text(data.ideia),
    };
  } catch {
    return null;
  }
}

export interface PilotCandidate {
  station: number;
  title: string;
  summary: string;
}

/** Ideias consolidadas da mesa, uma por estação que teve ideias anotadas. */
export function parseCandidates(
  raw: string,
  stations: number[],
): PilotCandidate[] | null {
  try {
    const { ideias } = JSON.parse(raw) as { ideias?: unknown };
    if (!Array.isArray(ideias)) return null;
    const seen = new Set<number>();
    const parsed: PilotCandidate[] = [];
    for (const item of ideias as Record<string, unknown>[]) {
      const station = Number(item.estacao);
      const title = text(item.titulo);
      const summary = text(item.resumo);
      if (!stations.includes(station) || seen.has(station)) continue;
      if (!title || !summary) continue;
      seen.add(station);
      parsed.push({ station, title, summary });
    }
    return parsed.length ? parsed.sort((a, b) => a.station - b.station) : null;
  } catch {
    return null;
  }
}

/** Plano de ação de 90 dias que a pessoa recebe na Chegada. */
export interface TrailPlanContent {
  titulo: string;
  objetivo: string;
  dor: { descricao: string; afetados: string; consequencia: string };
  dado: { fonte: string; mostra: string; lacunas: string; responsavel: string };
  dono: { responsavel: string; apoio: string; decisao: string };
  solucao: {
    capacidade: string;
    descricao: string;
    papelIa: string;
    papelServidor: string;
    foraDoEscopo: string;
  };
  indicadores: {
    nome: string;
    comoMedir: string;
    pontoDePartida: string;
    meta: string;
  }[];
  fases: {
    periodo: string;
    nome: string;
    foco: string;
    acoes: { acao: string; responsavel: string; entrega: string }[];
  }[];
  primeiraSemana: string[];
  riscos: { risco: string; prevencao: string }[];
  cuidados: { dados: string; revisaoHumana: string; transparencia: string };
  recursos: { jaTemos: string[]; precisamos: string[] };
  decisaoDia90: { continuar: string; ajustar: string; parar: string };
  trilha: { estacao: string; aproveitamento: string }[];
  conexaoPiloto: string;
  aConferir: string[];
}

/** Plano devolvido pela IA; nulo quando vier cortado ou sem o essencial. */
export function parsePlan(raw: string): TrailPlanContent | null {
  try {
    const plan = JSON.parse(raw) as TrailPlanContent;
    const complete =
      !!text(plan.titulo) &&
      !!text(plan.objetivo) &&
      !!text(plan.dor?.descricao) &&
      !!text(plan.solucao?.descricao) &&
      Array.isArray(plan.fases) &&
      plan.fases.length > 0 &&
      plan.fases.every((f) => Array.isArray(f.acoes) && f.acoes.length > 0);
    return complete ? plan : null;
  } catch {
    return null;
  }
}
