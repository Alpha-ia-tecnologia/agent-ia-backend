import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(companyId: string) {
    return this.prisma.department.findMany({
      where: { companyId },
      include: { agents: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(companyId: string, name: string) {
    return this.prisma.department.create({ data: { companyId, name } });
  }

  async update(companyId: string, id: string, name: string) {
    await this.ensureExists(companyId, id);
    return this.prisma.department.update({ where: { id }, data: { name } });
  }

  async remove(companyId: string, id: string) {
    await this.ensureExists(companyId, id);
    await this.prisma.department.delete({ where: { id } });
    return { deleted: true };
  }

  private async ensureExists(companyId: string, id: string) {
    const dep = await this.prisma.department.findFirst({
      where: { id, companyId },
    });
    if (!dep) throw new NotFoundException('Setor não encontrado');
    return dep;
  }
}
