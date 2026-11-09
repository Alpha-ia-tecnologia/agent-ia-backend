import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { PrismaService } from '../prisma/prisma.service';

@Controller('internal/company')
export class InternalCompanyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('info')
  @Public()
  @UseGuards(BridgeKeyGuard)
  async getInfo(@Query('companyId') companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        businessDescription: true,
        industry: true,
      },
    });

    if (!company) {
      return {
        error: 'Empresa não encontrada',
      };
    }

    const departments = await this.prisma.department.findMany({
      where: { companyId },
      select: {
        id: true,
        name: true,
      },
    });

    const agents = await this.prisma.agent.findMany({
      where: { companyId, isActive: true },
      select: {
        id: true,
        name: true,
        role: true,
        description: true,
        isManager: true,
        department: {
          select: {
            name: true,
          },
        },
      },
    });

    const users = (
      await this.prisma.membership.findMany({
        where: { companyId },
        select: {
          role: true,
          department: { select: { name: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      })
    ).map((m) => ({ ...m.user, role: m.role, department: m.department }));

    return {
      empresa: {
        nome: company.name,
        descricao: company.businessDescription || 'Não fornecida',
        setor: company.industry || 'Não fornecido',
      },
      departamentos: departments.map((d) => d.name),
      agentes: agents.map((a) => ({
        nome: a.name,
        cargo: a.role || 'Não definido',
        descricao: a.description || 'Nenhuma',
        gerente: a.isManager,
        departamento: a.department?.name || 'Nenhum',
      })),
      funcionarios: users.map((u) => ({
        nome: u.name,
        email: u.email,
        papel: u.role,
        departamento: u.department?.name || 'Nenhum',
      })),
    };
  }
}
