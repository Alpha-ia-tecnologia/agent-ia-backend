import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditFilter {
  type?: string;
  agentId?: string;
  conversationId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  take?: number;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async events(companyId: string, filter: AuditFilter) {
    const take = Math.min(Math.max(filter.take ?? 50, 1), 200);
    const events = await this.prisma.orchestrationEvent.findMany({
      where: {
        companyId,
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.conversationId
          ? { conversationId: filter.conversationId }
          : {}),
        createdAt: {
          ...(filter.from ? { gte: new Date(filter.from) } : {}),
          ...(filter.to ? { lte: new Date(filter.to) } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1, // +1 para saber se há próxima página
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      include: {
        conversation: { select: { id: true, title: true } },
      },
    });

    const hasMore = events.length > take;
    const page = hasMore ? events.slice(0, take) : events;

    // agentes num lookup só (evita include N+1 — agentId não é FK no modelo)
    const agentIds = [
      ...new Set(page.map((e) => e.agentId).filter(Boolean)),
    ] as string[];
    const agents = await this.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true, avatarSeed: true },
    });
    const agentById = new Map(agents.map((a) => [a.id, a]));

    return {
      events: page.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
        agent: e.agentId ? (agentById.get(e.agentId) ?? null) : null,
        conversation: e.conversation,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async summary(companyId: string) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const grouped = await this.prisma.orchestrationEvent.groupBy({
      by: ['type'],
      where: { companyId, createdAt: { gte: since } },
      _count: true,
    });
    return {
      since,
      byType: Object.fromEntries(grouped.map((g) => [g.type, g._count])),
      total: grouped.reduce((acc, g) => acc + g._count, 0),
    };
  }
}
