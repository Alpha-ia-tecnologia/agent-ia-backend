import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { forgetMembership } from '../auth/membership-cache';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const memberSelect = {
  role: true,
  createdAt: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  user: { select: { id: true, email: true, name: true } },
} satisfies Prisma.MembershipSelect;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof memberSelect }>;

/** Mesmo formato de antes (a web lê como "usuário da empresa"). */
const toMember = (m: MemberRow) => ({
  id: m.user.id,
  email: m.user.email,
  name: m.user.name,
  role: m.role,
  createdAt: m.createdAt,
  departmentId: m.departmentId,
  department: m.department,
});

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(companyId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { companyId },
      select: memberSelect,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toMember);
  }

  /**
   * "Adicionar funcionário": conta nova recebe senha temporária; e-mail que já
   * tem conta só ganha o vínculo com a org. Só o dono cria admin.
   */
  async invite(
    companyId: string,
    actor: AuthUser,
    name: string,
    email: string,
    role?: UserRole,
  ) {
    const memberRole =
      role === UserRole.ADMIN && actor.role === UserRole.OWNER
        ? UserRole.ADMIN
        : UserRole.MEMBER;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      const already = await this.prisma.membership.findUnique({
        where: { userId_companyId: { userId: existing.id, companyId } },
        select: { id: true },
      });
      if (already)
        throw new ConflictException('Essa pessoa já faz parte da organização');
      await this.prisma.membership.create({
        data: { userId: existing.id, companyId, role: memberRole },
      });
      return {
        id: existing.id,
        email: existing.email,
        name: existing.name,
        role: memberRole,
        temporaryPassword: null,
      };
    }

    const temporaryPassword = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);
    const user = await this.prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        companyId, // última org ativa: o primeiro login já cai nela
        memberships: { create: { companyId, role: memberRole } },
      },
      select: { id: true, email: true, name: true },
    });
    // Sem serviço de e-mail no MVP: a senha temporária é devolvida ao admin.
    return { ...user, role: memberRole, temporaryPassword };
  }

  /**
   * Nome e setor: dono/admin (ou a própria pessoa, só o nome). Papel: só o
   * dono, e nunca para/de OWNER — a org tem exatamente um dono.
   */
  async update(
    companyId: string,
    actor: AuthUser,
    id: string,
    data: { name?: string; role?: UserRole; departmentId?: string | null },
  ) {
    const target = await this.membership(companyId, id);
    if (data.role !== undefined) {
      if (actor.role !== UserRole.OWNER) {
        throw new ForbiddenException('Só o dono da organização altera papéis');
      }
      if (data.role === UserRole.OWNER || target.role === UserRole.OWNER) {
        throw new ForbiddenException('A organização tem um único dono');
      }
    }
    if (data.departmentId) {
      const dep = await this.prisma.department.findFirst({
        where: { id: data.departmentId, companyId },
        select: { id: true },
      });
      if (!dep) throw new NotFoundException('Setor não encontrado');
    }
    if (data.name !== undefined) {
      await this.prisma.user.update({
        where: { id },
        data: { name: data.name },
      });
    }
    const row = await this.prisma.membership.update({
      where: { userId_companyId: { userId: id, companyId } },
      data: { role: data.role, departmentId: data.departmentId },
      select: memberSelect,
    });
    forgetMembership(id, companyId); // novo papel vale na próxima requisição
    return toMember(row);
  }

  async getAgentAccess(companyId: string, userId: string) {
    const m = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { allAgents: true },
    });
    if (!m) throw new NotFoundException('Usuário não encontrado');
    if (m.allAgents) {
      // "todos os agentes": mostra todos marcados no editor
      const all = await this.prisma.agent.findMany({
        where: { companyId },
        select: { id: true },
      });
      return all.map((a) => a.id);
    }
    const rows = await this.prisma.userAgentAccess.findMany({
      where: { userId, agent: { companyId } },
      select: { agentId: true },
    });
    return rows.map((r) => r.agentId);
  }

  async setAgentAccess(companyId: string, userId: string, agentIds: string[]) {
    await this.membership(companyId, userId);
    const valid = await this.prisma.agent.findMany({
      where: { companyId, id: { in: agentIds } },
      select: { id: true },
    });
    const validIds = valid.map((a) => a.id);
    await this.prisma.$transaction([
      // só os acessos desta org: a pessoa pode estar em outras
      this.prisma.userAgentAccess.deleteMany({
        where: { userId, agent: { companyId } },
      }),
      this.prisma.userAgentAccess.createMany({
        data: validIds.map((agentId) => ({ userId, agentId })),
      }),
      // a lista escolhida pelo admin passa a valer no lugar de "todos"
      this.prisma.membership.update({
        where: { userId_companyId: { userId, companyId } },
        data: { allAgents: false },
      }),
    ]);
    return validIds;
  }

  /** Tira a pessoa da org (o vínculo); a conta continua existindo. */
  async remove(companyId: string, actor: AuthUser, id: string) {
    const target = await this.membership(companyId, id);
    // tirar um admin equivale a rebaixá-lo: só o dono pode
    if (target.role === UserRole.ADMIN && actor.role !== UserRole.OWNER) {
      throw new ForbiddenException(
        'Só o dono da organização remove administradores.',
      );
    }
    if (target.role === UserRole.OWNER) {
      throw new BadRequestException(
        'O dono não pode ser removido da organização.',
      );
    }
    await this.prisma.$transaction([
      this.prisma.userAgentAccess.deleteMany({
        where: { userId: id, agent: { companyId } },
      }),
      this.prisma.membership.delete({
        where: { userId_companyId: { userId: id, companyId } },
      }),
    ]);
    forgetMembership(id, companyId); // o token antigo perde o acesso na hora
    return { deleted: true };
  }

  private async membership(companyId: string, userId: string) {
    const m = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true },
    });
    if (!m) throw new NotFoundException('Usuário não encontrado');
    return m;
  }
}
