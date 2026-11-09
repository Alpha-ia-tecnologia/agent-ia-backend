import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AgentsService } from '../agents/agents.service';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { UsersService } from '../users/users.service';
import { guideIndex, PLATFORM_GUIDE } from './platform-guide';

/**
 * Ferramentas administrativas dos agentes (criar agente, convidar usuário) e
 * o guia da plataforma. As duas primeiras só são injetadas no chat quando o
 * usuário da conversa é OWNER/ADMIN (gate em conversations.service), mas o
 * papel também é revalidado aqui via requesterId. Erros viram { erro } legível.
 */
@Controller('internal/admin')
@UseGuards(BridgeKeyGuard)
export class InternalAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly users: UsersService,
  ) {}

  @Post('guia')
  @Public()
  guia(@Body() body: { topico?: string }) {
    const key = (body?.topico ?? '').toLowerCase().trim();
    const guide = PLATFORM_GUIDE[key];
    if (!guide) {
      return {
        erro: `Tópico desconhecido. Tópicos disponíveis:\n${guideIndex()}`,
      };
    }
    return { titulo: guide.titulo, passo_a_passo: guide.conteudo };
  }

  @Post('agentes/criar')
  @Public()
  async criarAgente(
    @Query('companyId') companyId: string,
    @Query('requesterId') requesterId: string,
    @Body()
    body: {
      nome?: string;
      cargo?: string;
      descricao?: string;
      setor?: string;
      prompt?: string;
    },
  ) {
    const denied = await this.requireAdmin(companyId, requesterId);
    if (denied) return denied;
    if (!body?.nome?.trim()) return { erro: 'Informe o nome do agente' };

    let departmentId: string | undefined;
    if (body.setor?.trim()) {
      const dept = await this.prisma.department.findFirst({
        where: {
          companyId,
          name: { contains: body.setor.trim(), mode: 'insensitive' },
        },
      });
      if (!dept) {
        const all = await this.prisma.department.findMany({
          where: { companyId },
          select: { name: true },
        });
        return {
          erro: `Setor "${body.setor}" não encontrado. Setores existentes: ${all.map((d) => d.name).join(', ') || '(nenhum)'}`,
        };
      }
      departmentId = dept.id;
    }
    const agent = await this.agents.create(companyId, {
      name: body.nome.trim(),
      role: body.cargo,
      description: body.descricao,
      systemPrompt: body.prompt,
      departmentId,
    });
    return {
      ok: true,
      agente: {
        id: agent.id,
        nome: agent.name,
        cargo: agent.role,
        setor: body.setor ?? null,
      },
      observacao:
        'Agente criado e ativo. O usuário pode ajustar prompt, modelo e acesso na página do agente.',
    };
  }

  @Post('usuarios/criar')
  @Public()
  async criarUsuario(
    @Query('companyId') companyId: string,
    @Query('requesterId') requesterId: string,
    @Body() body: { nome?: string; email?: string; papel?: string },
  ) {
    const denied = await this.requireAdmin(companyId, requesterId);
    if (denied) return denied;
    if (!body?.nome?.trim() || !body?.email?.trim()) {
      return { erro: 'Informe nome e email do novo usuário' };
    }
    const papel = (body.papel ?? '').toUpperCase();
    const role = papel === 'ADMIN' ? UserRole.ADMIN : UserRole.MEMBER; // OWNER nunca via agente
    try {
      const actor = await this.prisma.membership.findUniqueOrThrow({
        where: { userId_companyId: { userId: requesterId, companyId } },
        select: { role: true },
      });
      const user = await this.users.invite(
        companyId,
        { userId: requesterId, companyId, role: actor.role, email: '' },
        body.nome.trim(),
        body.email.trim(),
        role,
      );
      return {
        ok: true,
        usuario: { nome: user.name, email: user.email, papel: user.role },
        senha_temporaria: user.temporaryPassword,
        observacao:
          'Entregue a senha temporária ao usuário com segurança e oriente a troca no primeiro acesso.',
      };
    } catch (err) {
      return {
        erro: (err as { message?: string }).message ?? 'Falha ao criar usuário',
      };
    }
  }

  /** Papel revalidado no servidor — nunca confiar só na injeção da tool. */
  private async requireAdmin(companyId: string, requesterId: string) {
    if (!companyId || !requesterId) return { erro: 'Requisição inválida' };
    const requester = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId: requesterId, companyId } },
      select: { role: true },
    });
    if (!requester || requester.role === UserRole.MEMBER) {
      return {
        erro: 'Apenas administradores podem fazer isso. Peça a um administrador da empresa.',
      };
    }
    return null;
  }
}
