import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditService } from './audit.service';

@Controller('audit')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get('events')
  events(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: string,
    @Query('agentId') agentId?: string,
    @Query('conversationId') conversationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    return this.service.events(user.companyId, {
      type,
      agentId,
      conversationId,
      from,
      to,
      cursor,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.service.summary(user.companyId);
  }
}
