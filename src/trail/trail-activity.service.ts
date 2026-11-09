import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

export type TrailAction = 'analysis' | 'turn' | 'plan';
export type TrailPhase = 'routing' | 'working' | 'done';

export interface TrailActivity {
  id: string;
  companyId: string;
  runId: string;
  runName: string;
  /** conversa em que o agente trabalha */
  sessionId: string;
  userId: string;
  station: number;
  action: TrailAction;
  agentSlug: string;
  agentName: string;
  phase: TrailPhase;
  updatedAt: number;
}

/** Tempo que a entrega concluída continua visível no escritório. */
const DONE_VISIBLE_MS = 3_000;
/** Ação sem conclusão (processo interrompido) some depois deste tempo. */
const STALE_MS = 180_000;

/**
 * Qual agente trabalha agora em cada conversa. Fica em memória de propósito:
 * é efêmero e o evento roda em uma única instância.
 */
@Injectable()
export class TrailActivityService {
  private readonly items = new Map<string, TrailActivity>();

  start(
    data: Omit<TrailActivity, 'id' | 'phase' | 'updatedAt'>,
  ): TrailActivity {
    const activity: TrailActivity = {
      ...data,
      id: randomBytes(8).toString('hex'),
      phase: 'routing',
      updatedAt: Date.now(),
    };
    this.items.set(activity.id, activity);
    return activity;
  }

  /** O Guia definiu o responsável: o agente começa a trabalhar. */
  assign(id: string, agent: { slug: string; name: string }): void {
    const item = this.items.get(id);
    if (!item) return;
    item.agentSlug = agent.slug;
    item.agentName = agent.name;
    item.phase = 'working';
    item.updatedAt = Date.now();
  }

  finish(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.phase = 'done';
    item.updatedAt = Date.now();
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  /** runId omitido = toda a organização; null = pessoa ainda sem mesa. */
  list(companyId: string, runId?: string | null): TrailActivity[] {
    if (runId === null) return [];
    this.prune();
    return [...this.items.values()].filter(
      (i) =>
        i.companyId === companyId && (runId === undefined || i.runId === runId),
    );
  }

  /** Há um agente trabalhando nesta conversa? */
  busy(sessionId: string): boolean {
    this.prune();
    return [...this.items.values()].some(
      (i) => i.sessionId === sessionId && i.phase !== 'done',
    );
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, item] of this.items) {
      const age = now - item.updatedAt;
      if (age > (item.phase === 'done' ? DONE_VISIBLE_MS : STALE_MS)) {
        this.items.delete(id);
      }
    }
  }
}
