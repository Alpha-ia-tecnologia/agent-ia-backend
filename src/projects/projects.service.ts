import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

/** Transições permitidas (FINALIZADO → EM_ANDAMENTO é a reabertura). */
const STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  AGUARDANDO_INICIO: [ProjectStatus.EM_ANDAMENTO],
  EM_ANDAMENTO: [ProjectStatus.FINALIZADO],
  FINALIZADO: [ProjectStatus.EM_ANDAMENTO],
};

const SUMMARY_INCLUDE = {
  departments: {
    include: { department: { select: { id: true, name: true } } },
  },
  _count: { select: { tasks: true, conversations: true, documents: true } },
} as const;

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(companyId: string, userId: string, dto: CreateProjectDto) {
    const departmentIds = dto.allDepartments ? [] : (dto.departmentIds ?? []);
    if (departmentIds.length > 0) {
      const count = await this.prisma.department.count({
        where: { id: { in: departmentIds }, companyId },
      });
      if (count !== departmentIds.length) {
        throw new BadRequestException('Setor inválido para esta empresa');
      }
    }
    return this.prisma.project.create({
      data: {
        companyId,
        name: dto.name,
        description: dto.description,
        allDepartments: dto.allDepartments ?? departmentIds.length === 0,
        createdById: userId,
        departments: {
          create: departmentIds.map((departmentId) => ({ departmentId })),
        },
      },
      include: SUMMARY_INCLUDE,
    });
  }

  async findAll(companyId: string) {
    const projects = await this.prisma.project.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      include: SUMMARY_INCLUDE,
    });
    // contagem por status de task para o card ("quem está trabalhando")
    const grouped = await this.prisma.task.groupBy({
      by: ['projectId', 'status'],
      where: { companyId, projectId: { not: null } },
      _count: true,
    });
    return projects.map((p) => ({
      ...p,
      taskCounts: Object.fromEntries(
        grouped
          .filter((g) => g.projectId === p.id)
          .map((g) => [g.status, g._count]),
      ),
    }));
  }

  async findOne(companyId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, companyId },
      include: {
        ...SUMMARY_INCLUDE,
        documents: {
          select: {
            id: true,
            title: true,
            status: true,
            mimeType: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        taskLists: { orderBy: { position: 'asc' } },
      },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  async update(companyId: string, id: string, dto: UpdateProjectDto) {
    await this.getOwned(companyId, id);
    const departmentIds = dto.allDepartments ? [] : dto.departmentIds;
    if (departmentIds && departmentIds.length > 0) {
      const count = await this.prisma.department.count({
        where: { id: { in: departmentIds }, companyId },
      });
      if (count !== departmentIds.length) {
        throw new BadRequestException('Setor inválido para esta empresa');
      }
    }
    return this.prisma.project.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        allDepartments: dto.allDepartments,
        ...(departmentIds
          ? {
              departments: {
                deleteMany: {},
                create: departmentIds.map((departmentId) => ({ departmentId })),
              },
            }
          : {}),
      },
      include: SUMMARY_INCLUDE,
    });
  }

  async updateStatus(companyId: string, id: string, status: ProjectStatus) {
    const project = await this.getOwned(companyId, id);
    if (project.status === status) return project;
    if (!STATUS_TRANSITIONS[project.status].includes(status)) {
      throw new BadRequestException(
        `Transição inválida: ${project.status} → ${status}`,
      );
    }
    return this.prisma.project.update({
      where: { id },
      data: { status },
      include: SUMMARY_INCLUDE,
    });
  }

  async remove(companyId: string, id: string) {
    await this.getOwned(companyId, id);
    await this.prisma.project.delete({ where: { id } });
    return { deleted: true };
  }

  async getOwned(companyId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, companyId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }
}
