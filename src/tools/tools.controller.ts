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
import {
  AgentToolsDto,
  CreateToolDto,
  TestToolDto,
  UpdateToolDto,
} from './dto/tool.dto';
import { ToolsService } from './tools.service';

@Controller('tools')
export class ToolsController {
  constructor(private readonly service: ToolsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateToolDto) {
    return this.service.create(user.companyId, dto);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateToolDto,
  ) {
    return this.service.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }

  @Post(':id/test')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  test(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: TestToolDto,
  ) {
    return this.service.test(user.companyId, id, dto.args);
  }
}

@Controller('agents')
export class AgentToolsController {
  constructor(private readonly service: ToolsService) {}

  @Get(':id/tools')
  getAgentTools(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getAgentTools(user.companyId, id);
  }

  @Post(':id/tools')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setAgentTools(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AgentToolsDto,
  ) {
    return this.service.setAgentTools(user.companyId, id, dto.toolIds);
  }
}
