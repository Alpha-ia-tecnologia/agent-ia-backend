import { Injectable } from '@nestjs/common';
import { OnboardingStatus, UserRole } from '@prisma/client';
import { AuthService, type OrgSummary } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrgDto } from './orgs.dto';

@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async listMine(userId: string): Promise<OrgSummary[]> {
    return (await this.auth.sessionFor(userId)).orgs;
  }

  /** Cria uma organização com a pessoa como dona e já entra nela. */
  async create(userId: string, dto: CreateOrgDto) {
    const company = await this.prisma.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          name: dto.name.trim(),
          businessDescription: dto.businessDescription,
          industry: dto.industry,
          // os agentes da trilha já vêm prontos, sem o onboarding por IA
          onboardingStatus: OnboardingStatus.COMPLETED,
        },
      });
      await tx.membership.create({
        data: { userId, companyId: created.id, role: UserRole.OWNER },
      });
      return created;
    });
    return this.auth.switchOrg(userId, company.id);
  }
}
