import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateCompanyDto } from './dto/company.dto';

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  get(companyId: string) {
    return this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        businessDescription: true,
        industry: true,
      },
    });
  }

  async update(companyId: string, dto: UpdateCompanyDto) {
    const data: { name?: string } = {};
    if (dto.name !== undefined) data.name = dto.name;
    return this.prisma.company.update({
      where: { id: companyId },
      data,
      select: { id: true, name: true },
    });
  }
}
