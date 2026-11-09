import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { forgetMembership } from '../auth/membership-cache';
import { PrismaService } from '../prisma/prisma.service';
import { TrailService } from '../trail/trail.service';
import {
  formatInviteCode,
  generateInviteCode,
  normalizeInviteCode,
} from './invite-code';

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const ENTRY_CLOSED =
  'A entrada não está aberta no momento. Fale com o organizador.';
/** Teto de pessoas: a entrada não tem código, e cada uma consome a IA. */
const EVENT_MAX_ENTRIES = 300;

/** Não é um hash bcrypt válido: a conta de convidado nunca loga por senha. */
export const GUEST_PASSWORD_HASH = 'convidado-sem-senha';

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly trail: TrailService,
  ) {}

  async create(
    companyId: string,
    createdById: string,
    opts: {
      expiresInHours?: number;
      maxUses?: number;
      /** padrão: todos os agentes */
      allAgents?: boolean;
      agentIds?: string[];
    },
  ) {
    const allAgents = opts.allAgents ?? true;
    const agentIds = allAgents ? [] : [...new Set(opts.agentIds ?? [])];
    if (!allAgents) {
      const valid = await this.prisma.agent.count({
        where: { id: { in: agentIds }, companyId },
      });
      if (agentIds.length === 0 || valid !== agentIds.length) {
        throw new BadRequestException(
          'Escolha ao menos um agente desta organização para o convite.',
        );
      }
    }
    const expiresAt = opts.expiresInHours
      ? new Date(Date.now() + opts.expiresInHours * 3_600_000)
      : null;
    // 32^8 combinações: colisão é raríssima, mas o código é único no banco
    for (let attempt = 0; ; attempt++) {
      try {
        const invite = await this.prisma.orgInvite.create({
          data: {
            companyId,
            createdById,
            code: generateInviteCode(),
            expiresAt,
            maxUses: opts.maxUses ?? null,
            allAgents,
            agentIds,
          },
        });
        return this.view(invite);
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= 4) throw err;
      }
    }
  }

  async list(companyId: string) {
    const invites = await this.prisma.orgInvite.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { name: true } } },
    });
    return invites.map((i) => ({
      ...this.view(i),
      createdBy: i.createdBy?.name ?? null,
    }));
  }

  async revoke(companyId: string, id: string) {
    const res = await this.prisma.orgInvite.updateMany({
      where: { id, companyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Convite não encontrado.');
    return { revoked: true };
  }

  /** Público: o que a tela /join mostra antes de a pessoa aceitar. */
  async preview(rawCode: string) {
    const invite = await this.usable(rawCode);
    return {
      code: formatInviteCode(invite.code),
      companyName: invite.company.name,
    };
  }

  /**
   * Entra na organização do convite como MEMBER e devolve a sessão já nela.
   * Idempotente: quem já é membro só troca de org, sem gastar uso.
   */
  async accept(rawCode: string, userId: string) {
    // quem já é membro entra mesmo com o convite vencido/esgotado (ex.: QR de
    // uso único escaneado de novo); a validade só barra quem é novo
    const invite = await this.byCode(rawCode);
    const already = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId: invite.companyId } },
      select: { id: true },
    });
    if (!already) {
      this.assertUsable(invite);
      try {
        await this.prisma.$transaction(async (tx) => {
          // o uso é contado no próprio UPDATE: dois aceites no último uso
          // não passam juntos (o 2º relê a linha e não casa mais)
          const taken = await tx.orgInvite.updateMany({
            where: {
              id: invite.id,
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              ...(invite.maxUses != null
                ? { uses: { lt: invite.maxUses } }
                : {}),
            },
            data: { uses: { increment: 1 } },
          });
          if (taken.count === 0) {
            throw new GoneException('Este convite atingiu o limite de usos.');
          }
          // o acesso aos agentes vem do convite: todos, ou só os escolhidos
          // (sem o Gerente, a menos que ele esteja na lista)
          await tx.membership.create({
            data: {
              userId,
              companyId: invite.companyId,
              role: UserRole.MEMBER,
              allAgents: invite.allAgents,
              managerAccess: invite.allAgents,
            },
          });
          if (!invite.allAgents) {
            const still = await tx.agent.findMany({
              where: {
                id: { in: invite.agentIds },
                companyId: invite.companyId,
              },
              select: { id: true },
            });
            await tx.userAgentAccess.createMany({
              data: still.map((a) => ({ userId, agentId: a.id })),
              skipDuplicates: true,
            });
          }
        });
      } catch (err) {
        // mesmo usuário aceitando em paralelo: o outro aceite já criou o vínculo
        if (!isUniqueViolation(err)) throw err;
      }
    }
    forgetMembership(userId, invite.companyId);
    return this.auth.switchOrg(userId, invite.companyId);
  }

  /**
   * Entrada do evento: só nome e código, sem e-mail nem senha. Cria uma conta
   * de convidado (e-mail sintético, sem senha), coloca na organização do
   * convite e reserva o lugar em uma mesa. Cada entrada é uma conta nova e
   * gasta um uso do convite.
   */
  async enter(rawCode: string, name: string) {
    // código inválido não pode criar conta
    await this.usable(rawCode);
    const guest = await this.prisma.user.create({
      data: {
        email: `convidado-${randomBytes(8).toString('hex')}@evento.local`,
        passwordHash: GUEST_PASSWORD_HASH,
        name,
      },
      select: { id: true },
    });
    let session: Awaited<ReturnType<InvitesService['accept']>>;
    try {
      session = await this.accept(rawCode, guest.id);
    } catch (err) {
      // limite de usos atingido em paralelo: não deixa conta órfã
      await this.prisma.user.delete({ where: { id: guest.id } });
      throw err;
    }
    const companyId = session.user.companyId;
    if (companyId) {
      // se falhar, a tela da trilha tenta de novo ao abrir
      await this.trail.assignRoom(guest.id, companyId).catch((err: Error) => {
        this.logger.warn(`Mesa não reservada na entrada: ${err.message}`);
      });
    }
    return session;
  }

  /**
   * Entrada do evento só com o nome. Os participantes vão para a organização
   * que abriu a entrada pelo telão; com ela fechada, ninguém novo entra.
   */
  async enterEvent(name: string) {
    const event = await this.prisma.trailEvent.findFirst({
      where: { entryOpen: true },
      select: { companyId: true },
    });
    const invite = event
      ? await this.prisma.orgInvite.findFirst({
          where: {
            companyId: event.companyId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
          select: { code: true },
        })
      : null;
    if (!invite) throw new GoneException(ENTRY_CLOSED);
    try {
      return await this.enter(invite.code, name);
    } catch (err) {
      if (err instanceof GoneException) throw new GoneException(ENTRY_CLOSED);
      throw err;
    }
  }

  async eventEntry(companyId: string) {
    const event = await this.prisma.trailEvent.findUnique({
      where: { companyId },
      select: { entryOpen: true },
    });
    return { open: !!event?.entryOpen };
  }

  /**
   * Abre ou encerra a entrada só com o nome. Só uma organização pode estar
   * aberta: quem abre primeiro recebe os participantes, então uma conta criada
   * depois não consegue desviar a entrada do evento.
   */
  async setEventEntry(companyId: string, userId: string, open: boolean) {
    if (open) {
      const other = await this.prisma.trailEvent.findFirst({
        where: { entryOpen: true, companyId: { not: companyId } },
        select: { companyId: true },
      });
      if (other) {
        throw new ConflictException(
          'Outra organização já está com a entrada aberta.',
        );
      }
      await this.create(companyId, userId, {
        expiresInHours: 12,
        maxUses: EVENT_MAX_ENTRIES,
      });
    }
    await this.prisma.trailEvent.upsert({
      where: { companyId },
      create: { companyId, entryOpen: open },
      update: { entryOpen: open },
    });
    return { open };
  }

  private async usable(rawCode: string) {
    const invite = await this.byCode(rawCode);
    this.assertUsable(invite);
    return invite;
  }

  private async byCode(rawCode: string) {
    const invite = await this.prisma.orgInvite.findUnique({
      where: { code: normalizeInviteCode(rawCode) },
      include: { company: { select: { name: true } } },
    });
    if (!invite) {
      throw new NotFoundException('Convite não encontrado. Confira o código.');
    }
    return invite;
  }

  private assertUsable(invite: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    maxUses: number | null;
    uses: number;
  }) {
    if (invite.revokedAt) {
      throw new GoneException('Este convite foi cancelado.');
    }
    if (invite.expiresAt && invite.expiresAt <= new Date()) {
      throw new GoneException('Este convite expirou.');
    }
    if (invite.maxUses != null && invite.uses >= invite.maxUses) {
      throw new GoneException('Este convite atingiu o limite de usos.');
    }
  }

  private view(i: {
    id: string;
    code: string;
    expiresAt: Date | null;
    maxUses: number | null;
    uses: number;
    revokedAt: Date | null;
    createdAt: Date;
    allAgents: boolean;
    agentIds: string[];
  }) {
    return {
      id: i.id,
      code: formatInviteCode(i.code),
      expiresAt: i.expiresAt,
      maxUses: i.maxUses,
      uses: i.uses,
      revokedAt: i.revokedAt,
      createdAt: i.createdAt,
      allAgents: i.allAgents,
      agentIds: i.agentIds,
    };
  }
}
