import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { TASK_INCLUDE, TasksService } from './tasks.service';

const STATUS_LABEL: Record<TaskStatus, string> = {
  A_FAZER: 'A fazer',
  EM_ANDAMENTO: 'Em andamento',
  EM_REVISAO: 'Em revisão',
  CONCLUIDA: 'Concluída',
};

/**
 * Consumido pelo bridge via as ferramentas de projeto/tarefas dos agentes.
 * companyId (e projectId, quando a conversa é de um projeto) viajam na query;
 * o modelo controla o body. Erros de uso viram { erro } legível (HTTP 200).
 * NÃO há exclusão: agentes nunca excluem nada (regra do produto).
 */
@Controller('internal/projects')
@UseGuards(BridgeKeyGuard)
export class InternalProjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  @Get('info')
  @Public()
  async info(
    @Query('companyId') companyId: string,
    @Query('projectId') projectId: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, companyId },
      include: {
        departments: { include: { department: { select: { name: true } } } },
      },
    });
    if (!project) return { erro: 'Projeto não encontrado' };
    return {
      projeto: {
        nome: project.name,
        descricao: project.description,
        status: project.status,
        requisitos: project.requirements,
        setores: project.allDepartments
          ? 'todos os setores da empresa'
          : project.departments.map((d) => d.department.name),
      },
    };
  }

  @Post('tarefas/listar')
  @Public()
  async listar(
    @Query('companyId') companyId: string,
    @Query('projectId') projectId: string | undefined,
    @Body() body: { status?: string; lista?: string },
  ) {
    const status = this.parseStatus(body?.status);
    if (body?.status && !status) return this.statusError();
    const tarefas = await this.prisma.task.findMany({
      where: {
        companyId,
        ...(projectId ? { projectId } : { projectId: null }),
        ...(status ? { status } : {}),
        ...(body?.lista
          ? { list: { name: { contains: body.lista, mode: 'insensitive' } } }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { position: 'asc' }],
      include: TASK_INCLUDE,
      take: 100,
    });
    return {
      total: tarefas.length,
      tarefas: tarefas.map((t) => this.toAgentView(t)),
    };
  }

  @Post('tarefas/criar')
  @Public()
  async criar(
    @Query('companyId') companyId: string,
    @Query('projectId') projectId: string | undefined,
    @Body()
    body: {
      titulo?: string;
      descricao?: string;
      prioridade?: string;
      lista?: string;
      responsaveis?: string[];
    },
  ) {
    if (!body?.titulo?.trim()) return { erro: 'Informe o título da tarefa' };

    let listId: string | undefined;
    if (body.lista?.trim()) {
      let list = await this.prisma.taskList.findFirst({
        where: {
          companyId,
          projectId: projectId ?? null,
          name: { equals: body.lista.trim(), mode: 'insensitive' },
        },
      });
      list ??= await this.tasks.createList(companyId, {
        name: body.lista.trim(),
        projectId,
      });
      listId = list.id;
    }

    const members = await this.resolveMembers(companyId, body.responsaveis);
    if ('erro' in members) return members;

    const prioridade = (body.prioridade ?? '').toUpperCase();
    const task = await this.tasks.create(
      companyId,
      {
        title: body.titulo.trim(),
        description: body.descricao,
        projectId,
        listId,
        priority: ['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'].includes(prioridade)
          ? (prioridade as never)
          : undefined,
        memberUserIds: members.userIds,
        memberAgentIds: members.agentIds,
      },
      { createdByAgent: true },
    );
    return { ok: true, tarefa: this.toAgentView(task) };
  }

  @Post('tarefas/atualizar-status')
  @Public()
  async atualizarStatus(
    @Query('companyId') companyId: string,
    @Query('projectId') projectId: string | undefined,
    @Body() body: { tarefa_id?: string; titulo?: string; status?: string },
  ) {
    const status = this.parseStatus(body?.status);
    if (!status) return this.statusError();
    const found = await this.findTask(companyId, projectId, body);
    if ('erro' in found) return found;
    const updated = await this.tasks.update(companyId, found.id, { status });
    return { ok: true, tarefa: this.toAgentView(updated) };
  }

  @Post('tarefas/atribuir')
  @Public()
  async atribuir(
    @Query('companyId') companyId: string,
    @Query('projectId') projectId: string | undefined,
    @Body() body: { tarefa_id?: string; titulo?: string; nome?: string },
  ) {
    if (!body?.nome?.trim()) return { erro: 'Informe o nome do responsável' };
    const found = await this.findTask(companyId, projectId, body);
    if ('erro' in found) return found;
    const members = await this.resolveMembers(companyId, [body.nome]);
    if ('erro' in members) return members;
    await this.tasks.addMember(companyId, found.id, {
      userId: members.userIds[0],
      agentId: members.agentIds[0],
    });
    const updated = await this.tasks.findOne(companyId, found.id);
    return { ok: true, tarefa: this.toAgentView(updated) };
  }

  // ---- helpers --------------------------------------------------------------

  private async findTask(
    companyId: string,
    projectId: string | undefined,
    body: { tarefa_id?: string; titulo?: string },
  ) {
    if (body?.tarefa_id) {
      const task = await this.prisma.task.findFirst({
        where: { id: body.tarefa_id, companyId },
      });
      return task ?? { erro: 'Tarefa não encontrada por esse id' };
    }
    if (!body?.titulo?.trim()) {
      return { erro: 'Informe tarefa_id ou o título da tarefa' };
    }
    const candidates = await this.prisma.task.findMany({
      where: {
        companyId,
        ...(projectId ? { projectId } : {}),
        title: { contains: body.titulo.trim(), mode: 'insensitive' },
      },
      take: 5,
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0)
      return { erro: 'Nenhuma tarefa com esse título' };
    return {
      erro: `Título ambíguo — candidatas: ${candidates
        .map((c) => `"${c.title}" (id ${c.id})`)
        .join('; ')}. Use tarefa_id.`,
    };
  }

  /** Resolve nomes contra agentes e usuários da empresa (case-insensitive). */
  private async resolveMembers(companyId: string, nomes?: string[]) {
    const userIds: string[] = [];
    const agentIds: string[] = [];
    for (const nome of nomes ?? []) {
      const n = nome.trim();
      if (!n) continue;
      const [agents, users] = await Promise.all([
        this.prisma.agent.findMany({
          where: { companyId, name: { contains: n, mode: 'insensitive' } },
          select: { id: true, name: true },
          take: 3,
        }),
        this.prisma.user.findMany({
          where: {
            memberships: { some: { companyId } },
            name: { contains: n, mode: 'insensitive' },
          },
          select: { id: true, name: true },
          take: 3,
        }),
      ]);
      const total = agents.length + users.length;
      if (total === 0) {
        return { erro: `Nenhum agente ou usuário chamado "${n}"` };
      }
      if (total > 1) {
        const options = [
          ...agents.map((a) => `${a.name} (agente)`),
          ...users.map((u) => `${u.name} (usuário)`),
        ].join(', ');
        return {
          erro: `Nome "${n}" é ambíguo — candidatos: ${options}. Seja mais específico.`,
        };
      }
      if (agents.length === 1) agentIds.push(agents[0].id);
      else userIds.push(users[0].id);
    }
    return { userIds, agentIds };
  }

  private parseStatus(value?: string): TaskStatus | null {
    if (!value) return null;
    const norm = value
      .toUpperCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '_');
    return (Object.values(TaskStatus) as string[]).includes(norm)
      ? (norm as TaskStatus)
      : null;
  }

  private statusError() {
    return {
      erro: `Status inválido. Use um de: ${Object.values(TaskStatus).join(', ')}`,
    };
  }

  private toAgentView(t: {
    id: string;
    title: string;
    status: TaskStatus;
    priority: string;
    dueDate: Date | null;
    list?: { name: string } | null;
    members?: {
      user?: { name: string } | null;
      agent?: { name: string } | null;
    }[];
  }) {
    return {
      id: t.id,
      titulo: t.title,
      status: t.status,
      status_legivel: STATUS_LABEL[t.status],
      prioridade: t.priority,
      prazo: t.dueDate?.toISOString().slice(0, 10) ?? null,
      lista: t.list?.name ?? null,
      responsaveis: (t.members ?? []).map((m) =>
        m.agent ? `${m.agent.name} (agente)` : `${m.user?.name} (usuário)`,
      ),
    };
  }
}
