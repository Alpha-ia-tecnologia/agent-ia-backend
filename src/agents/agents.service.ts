import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { agentScope, agentScopeFilter } from './agent-access';
import { CreateAgentDto, UpdateAgentDto } from './dto/agent.dto';

export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Nomes femininos comuns que não terminam em "a" / masculinos que terminam.
const FEMALE_NAMES = new Set([
  'isabel',
  'raquel',
  'beatriz',
  'ines',
  'ester',
  'esther',
  'carmen',
  'ruth',
  'rute',
  'miriam',
  'simone',
  'michele',
  'michelle',
  'nicole',
  'ingrid',
  'kelly',
  'evelyn',
  'denise',
  'elaine',
  'aline',
  'jaqueline',
  'caroline',
  'rachel',
  'lais',
  'thais',
  'iris',
]);
const MALE_NAMES = new Set(['luca', 'jonata', 'josue', 'nikita']);

/** Prefixa a seed com f-/m- para o avatar (web) combinar com o nome. */
export function genderedSeed(name: string, seed: string): string {
  const first = slugify(name).split('-')[0] ?? '';
  if (!first) return seed;
  if (MALE_NAMES.has(first)) return `m-${seed}`;
  if (FEMALE_NAMES.has(first) || first.endsWith('a')) return `f-${seed}`;
  return `m-${seed}`;
}

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    companyId: string,
    requester?: { userId: string; role: UserRole },
  ) {
    // Membro só enxerga o que o convite/admin liberou (ver agent-access.ts)
    const filter =
      requester?.role === UserRole.MEMBER
        ? agentScopeFilter(
            requester.userId,
            await agentScope(this.prisma, requester.userId, companyId),
          )
        : {};
    return this.prisma.agent.findMany({
      where: { companyId, ...filter },
      include: { department: true },
      orderBy: [{ isManager: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(companyId: string, id: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id, companyId },
      include: {
        department: true,
        userAccess: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    if (!agent) throw new NotFoundException('Agente não encontrado');
    return agent;
  }

  async create(companyId: string, dto: CreateAgentDto) {
    const slug = await this.uniqueSlug(companyId, dto.name);
    return this.prisma.agent.create({
      data: {
        companyId,
        name: dto.name,
        slug,
        avatarSeed: dto.avatarSeed ?? genderedSeed(dto.name, slug),
        role: dto.role,
        description: dto.description,
        systemPrompt: dto.systemPrompt ?? '',
        departmentId: dto.departmentId,
        capabilities: (dto.capabilities ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async update(companyId: string, id: string, dto: UpdateAgentDto) {
    await this.findOne(companyId, id);
    return this.prisma.agent.update({
      where: { id },
      data: {
        ...dto,
        capabilities: dto.capabilities as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    await this.prisma.agent.delete({ where: { id } });
    return { deleted: true };
  }

  async getAccess(companyId: string, agentId: string) {
    await this.findOne(companyId, agentId);
    const rows = await this.prisma.userAgentAccess.findMany({
      where: { agentId },
      select: { userId: true },
    });
    return { userIds: rows.map((r) => r.userId) };
  }

  async setAccess(companyId: string, agentId: string, userIds: string[]) {
    await this.findOne(companyId, agentId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, memberships: { some: { companyId } } },
      select: { id: true },
    });
    if (users.length !== userIds.length) {
      throw new NotFoundException('Usuário não encontrado');
    }
    await this.prisma.$transaction([
      this.prisma.userAgentAccess.deleteMany({ where: { agentId } }),
      this.prisma.userAgentAccess.createMany({
        data: userIds.map((userId) => ({ userId, agentId })),
      }),
    ]);
    return { userIds };
  }

  async revokeAccess(companyId: string, agentId: string, userId: string) {
    await this.findOne(companyId, agentId);
    await this.prisma.userAgentAccess.deleteMany({
      where: { userId, agentId },
    });
    return { deleted: true };
  }

  private async uniqueSlug(companyId: string, name: string) {
    const base = slugify(name) || 'agente';
    let slug = base;
    let i = 1;
    while (await this.prisma.agent.findFirst({ where: { companyId, slug } })) {
      slug = `${base}-${++i}`;
    }
    return slug;
  }
}
