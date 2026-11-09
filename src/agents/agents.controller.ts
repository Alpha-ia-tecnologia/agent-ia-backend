import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentsService } from './agents.service';
import {
  AgentAccessDto,
  CreateAgentDto,
  UpdateAgentDto,
} from './dto/agent.dto';

@Controller('agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.companyId, {
      userId: user.userId,
      role: user.role,
    });
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user.companyId, id);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAgentDto) {
    return this.service.create(user.companyId, dto);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.service.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }

  @Get(':id/access')
  getAccess(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getAccess(user.companyId, id);
  }

  @Post(':id/access')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setAccess(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AgentAccessDto,
  ) {
    return this.service.setAccess(user.companyId, id, dto.userIds);
  }

  @Delete(':id/access/:userId')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  revokeAccess(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.service.revokeAccess(user.companyId, id, userId);
  }
}
