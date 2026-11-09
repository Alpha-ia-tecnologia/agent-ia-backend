import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UsersService } from './users.service';

class InviteUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  // string vazia = remover do setor
  @IsOptional()
  @IsString()
  departmentId?: string;
}

class UserAgentAccessDto {
  @IsString({ each: true })
  agentIds: string[];
}

@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  invite(@CurrentUser() user: AuthUser, @Body() dto: InviteUserDto) {
    return this.service.invite(
      user.companyId,
      user,
      dto.name,
      dto.email,
      dto.role,
    );
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.service.update(user.companyId, user, id, {
      name: dto.name,
      role: dto.role,
      departmentId:
        dto.departmentId === undefined ? undefined : dto.departmentId || null,
    });
  }

  @Get(':id/agent-access')
  getAgentAccess(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getAgentAccess(user.companyId, id);
  }

  @Put(':id/agent-access')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setAgentAccess(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UserAgentAccessDto,
  ) {
    return this.service.setAgentAccess(user.companyId, id, dto.agentIds ?? []);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, user, id);
  }
}
