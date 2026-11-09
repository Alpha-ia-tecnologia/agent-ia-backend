import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ORCHESTRATOR_SLUG,
  TRAIL_AGENTS,
  type TrailAgentSeed,
} from './trail.agents';

export class TrailAgentSet {
  constructor(private readonly agents: TrailAgentSeed[]) {}

  get orchestrator(): TrailAgentSeed {
    return this.agents.find((a) => a.slug === ORCHESTRATOR_SLUG)!;
  }

  get specialists(): TrailAgentSeed[] {
    return this.agents.filter((a) => a.station !== null);
  }

  specialistFor(station: number): TrailAgentSeed {
    return this.agents.find((a) => a.station === station)!;
  }

  bySlug(slug: string): TrailAgentSeed | undefined {
    return this.specialists.find((a) => a.slug === slug);
  }
}

@Injectable()
export class TrailAgentsService {
  private readonly ensured = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Cadastra os agentes da trilha na organização, sem sobrescrever ajustes. */
  async ensure(companyId: string): Promise<void> {
    if (this.ensured.has(companyId)) return;
    await this.prisma.agent.createMany({
      data: TRAIL_AGENTS.map((a) => ({
        companyId,
        slug: a.slug,
        name: a.name,
        role: a.role,
        description: a.description,
        systemPrompt: a.systemPrompt,
        isManager: a.isManager,
        avatarSeed: a.slug,
      })),
      skipDuplicates: true,
    });
    this.ensured.add(companyId);
  }

  /** Agentes como estão no painel; o que foi removido volta ao valor inicial. */
  async load(companyId: string): Promise<TrailAgentSet> {
    await this.ensure(companyId);
    const rows = await this.prisma.agent.findMany({
      where: { companyId, slug: { in: TRAIL_AGENTS.map((a) => a.slug) } },
      select: { slug: true, name: true, systemPrompt: true },
    });
    return new TrailAgentSet(
      TRAIL_AGENTS.map((seed) => ({
        ...seed,
        ...rows.find((r) => r.slug === seed.slug),
      })),
    );
  }
}
