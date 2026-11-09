import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddTaskMemberDto,
  CreateTaskDto,
  CreateTaskListDto,
  MoveTaskDto,
  TaskFilterDto,
  UpdateTaskDto,
} from './dto/task.dto';

export const TASK_INCLUDE = {
  list: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
  members: {
    include: {
      user: { select: { id: true, name: true } },
      agent: { select: { id: true, name: true, avatarSeed: true } },
    },
  },
} satisfies Prisma.TaskInclude;

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- listas ---------------------------------------------------------------

  async createList(companyId: string, dto: CreateTaskListDto) {
    if (dto.projectId) await this.ensureProject(companyId, dto.projectId);
    const last = await this.prisma.taskList.findFirst({
      where: { companyId, projectId: dto.projectId ?? null },
      orderBy: { position: 'desc' },
    });
    return this.prisma.taskList.create({
      data: {
        companyId,
        projectId: dto.projectId ?? null,
        name: dto.name,
        position: (last?.position ?? -1) + 1,
      },
    });
  }

  listLists(companyId: string, projectId?: string) {
    return this.prisma.taskList.findMany({
      where: {
        companyId,
        ...(projectId !== undefined ? { projectId: projectId || null } : {}),
      },
      orderBy: { position: 'asc' },
      include: { _count: { select: { tasks: true } } },
    });
  }

  async renameList(companyId: string, id: string, name: string) {
    await this.ensureList(companyId, id);
    return this.prisma.taskList.update({ where: { id }, data: { name } });
  }

  async removeList(companyId: string, id: string) {
    await this.ensureList(companyId, id);
    // tasks sobrevivem (listId vira null via SetNull)
    await this.prisma.taskList.delete({ where: { id } });
    return { deleted: true };
  }

  // ---- tasks ----------------------------------------------------------------

  async create(
    companyId: string,
    dto: CreateTaskDto,
    opts?: { createdByAgent?: boolean },
  ) {
    if (dto.projectId) await this.ensureProject(companyId, dto.projectId);
    if (dto.listId) {
      const list = await this.ensureList(companyId, dto.listId);
      if (dto.projectId && list.projectId && list.projectId !== dto.projectId) {
        throw new BadRequestException('A lista pertence a outro projeto');
      }
    }
    const memberUserIds = [...new Set(dto.memberUserIds ?? [])];
    const memberAgentIds = [...new Set(dto.memberAgentIds ?? [])];
    await this.validateMembers(companyId, memberUserIds, memberAgentIds);

    const last = await this.prisma.task.findFirst({
      where: { companyId, status: TaskStatus.A_FAZER },
      orderBy: { position: 'desc' },
    });
    return this.prisma.task.create({
      data: {
        companyId,
        projectId: dto.projectId ?? null,
        listId: dto.listId ?? null,
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        position: (last?.position ?? -1) + 1,
        createdByAgent: opts?.createdByAgent ?? false,
        members: {
          create: [
            ...memberUserIds.map((userId) => ({ userId })),
            ...memberAgentIds.map((agentId) => ({ agentId })),
          ],
        },
      },
      include: TASK_INCLUDE,
    });
  }

  findAll(companyId: string, filter: TaskFilterDto) {
    return this.prisma.task.findMany({
      where: {
        companyId,
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.isolated === 'true' ? { projectId: null } : {}),
        ...(filter.listId ? { listId: filter.listId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { position: 'asc' }],
      include: TASK_INCLUDE,
    });
  }

  async findOne(companyId: string, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, companyId },
      include: TASK_INCLUDE,
    });
    if (!task) throw new NotFoundException('Tarefa não encontrada');
    return task;
  }

  async update(companyId: string, id: string, dto: UpdateTaskDto) {
    await this.findOne(companyId, id);
    if (dto.listId) {
      await this.ensureList(companyId, dto.listId);
    }
    return this.prisma.task.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        listId: dto.listId === undefined ? undefined : dto.listId,
        dueDate:
          dto.dueDate === undefined
            ? undefined
            : dto.dueDate
              ? new Date(dto.dueDate)
              : null,
      },
      include: TASK_INCLUDE,
    });
  }

  /** Move no kanban: muda status e insere na posição, reordenando a coluna. */
  async move(companyId: string, id: string, dto: MoveTaskDto) {
    const task = await this.findOne(companyId, id);
    return this.prisma.$transaction(async (tx) => {
      // abre espaço na coluna destino
      await tx.task.updateMany({
        where: {
          companyId,
          status: dto.status,
          position: { gte: dto.position },
          id: { not: id },
        },
        data: { position: { increment: 1 } },
      });
      return tx.task.update({
        where: { id: task.id },
        data: { status: dto.status, position: dto.position },
        include: TASK_INCLUDE,
      });
    });
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    await this.prisma.task.delete({ where: { id } });
    return { deleted: true };
  }

  // ---- membros --------------------------------------------------------------

  async addMember(companyId: string, taskId: string, dto: AddTaskMemberDto) {
    if (Boolean(dto.userId) === Boolean(dto.agentId)) {
      throw new BadRequestException('Informe exatamente um: userId ou agentId');
    }
    await this.findOne(companyId, taskId);
    await this.validateMembers(
      companyId,
      dto.userId ? [dto.userId] : [],
      dto.agentId ? [dto.agentId] : [],
    );
    const existing = await this.prisma.taskMember.findFirst({
      where: {
        taskId,
        ...(dto.userId ? { userId: dto.userId } : { agentId: dto.agentId }),
      },
    });
    if (existing) return existing;
    return this.prisma.taskMember.create({
      data: {
        taskId,
        userId: dto.userId ?? null,
        agentId: dto.agentId ?? null,
      },
      include: {
        user: { select: { id: true, name: true } },
        agent: { select: { id: true, name: true, avatarSeed: true } },
      },
    });
  }

  async removeMember(companyId: string, taskId: string, memberId: string) {
    await this.findOne(companyId, taskId);
    const member = await this.prisma.taskMember.findFirst({
      where: { id: memberId, taskId },
    });
    if (!member) throw new NotFoundException('Membro não encontrado');
    await this.prisma.taskMember.delete({ where: { id: memberId } });
    return { deleted: true };
  }

  // ---- helpers --------------------------------------------------------------

  private async validateMembers(
    companyId: string,
    userIds: string[],
    agentIds: string[],
  ) {
    if (userIds.length > 0) {
      const count = await this.prisma.user.count({
        where: { id: { in: userIds }, memberships: { some: { companyId } } },
      });
      if (count !== userIds.length) {
        throw new BadRequestException('Usuário inválido para esta empresa');
      }
    }
    if (agentIds.length > 0) {
      const count = await this.prisma.agent.count({
        where: { id: { in: agentIds }, companyId },
      });
      if (count !== agentIds.length) {
        throw new BadRequestException('Agente inválido para esta empresa');
      }
    }
  }

  private async ensureProject(companyId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, companyId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  private async ensureList(companyId: string, listId: string) {
    const list = await this.prisma.taskList.findFirst({
      where: { id: listId, companyId },
    });
    if (!list) throw new NotFoundException('Lista não encontrada');
    return list;
  }
}
