import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function periodStart(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  private range(from?: string, to?: string) {
    return {
      gte: from ? new Date(from) : periodStart(30),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  async summary(companyId: string, from?: string, to?: string) {
    const createdAt = this.range(from, to);
    const totals = await this.prisma.tokenUsage.aggregate({
      where: { companyId, createdAt },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      _count: true,
    });
    // Série diária para o gráfico (agregada no banco).
    const daily = await this.prisma.$queryRaw<{ day: Date; total: bigint }[]>(
      Prisma.sql`SELECT date_trunc('day', "createdAt") AS day, SUM("totalTokens")::bigint AS total
        FROM "TokenUsage"
        WHERE "companyId" = ${companyId} AND "createdAt" >= ${createdAt.gte}
        ${to ? Prisma.sql`AND "createdAt" <= ${new Date(to)}` : Prisma.empty}
        GROUP BY 1 ORDER BY 1`,
    );
    return {
      promptTokens: totals._sum.promptTokens ?? 0,
      completionTokens: totals._sum.completionTokens ?? 0,
      totalTokens: totals._sum.totalTokens ?? 0,
      turns: totals._count,
      daily: daily.map((d) => ({
        day: d.day.toISOString().slice(0, 10),
        total: Number(d.total),
      })),
    };
  }

  async byAgent(companyId: string, from?: string, to?: string) {
    const rows = await this.prisma.tokenUsage.groupBy({
      by: ['agentId'],
      where: { companyId, createdAt: this.range(from, to) },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      _count: true,
      orderBy: { _sum: { totalTokens: 'desc' } },
    });
    const agents = await this.prisma.agent.findMany({
      where: {
        id: { in: rows.map((r) => r.agentId).filter(Boolean) as string[] },
      },
      select: { id: true, name: true, role: true, avatarSeed: true },
    });
    const byId = new Map(agents.map((a) => [a.id, a]));
    return rows.map((r) => ({
      agent: r.agentId ? (byId.get(r.agentId) ?? null) : null,
      promptTokens: r._sum.promptTokens ?? 0,
      completionTokens: r._sum.completionTokens ?? 0,
      totalTokens: r._sum.totalTokens ?? 0,
      turns: r._count,
    }));
  }

  async byUser(companyId: string, from?: string, to?: string) {
    const rows = await this.prisma.tokenUsage.groupBy({
      by: ['userId'],
      where: { companyId, createdAt: this.range(from, to) },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      _count: true,
      orderBy: { _sum: { totalTokens: 'desc' } },
    });
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: rows.map((r) => r.userId).filter(Boolean) as string[] },
      },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      user: r.userId ? (byId.get(r.userId) ?? null) : null,
      promptTokens: r._sum.promptTokens ?? 0,
      completionTokens: r._sum.completionTokens ?? 0,
      totalTokens: r._sum.totalTokens ?? 0,
      turns: r._count,
    }));
  }

  async forUser(companyId: string, userId: string, from?: string, to?: string) {
    const totals = await this.prisma.tokenUsage.aggregate({
      where: { companyId, userId, createdAt: this.range(from, to) },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
      _count: true,
    });
    return {
      promptTokens: totals._sum.promptTokens ?? 0,
      completionTokens: totals._sum.completionTokens ?? 0,
      totalTokens: totals._sum.totalTokens ?? 0,
      turns: totals._count,
    };
  }
}
