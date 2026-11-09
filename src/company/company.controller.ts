import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/company.dto';

@Controller('company')
export class CompanyController {
  constructor(private readonly service: CompanyService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.service.get(user.companyId);
  }

  @Patch()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateCompanyDto) {
    return this.service.update(user.companyId, dto);
  }
}
