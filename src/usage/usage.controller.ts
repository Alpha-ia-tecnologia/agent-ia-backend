import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly service: UsageService) {}

  @Get('summary')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  summary(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.summary(user.companyId, from, to);
  }

  @Get('by-agent')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  byAgent(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.byAgent(user.companyId, from, to);
  }

  @Get('by-user')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  byUser(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.byUser(user.companyId, from, to);
  }

  /** Consumo do próprio usuário (qualquer papel). */
  @Get('me')
  me(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.forUser(user.companyId, user.userId, from, to);
  }
}
