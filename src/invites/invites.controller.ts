import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { NoOrg } from '../auth/decorators/no-org.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { InvitesService } from './invites.service';

class CreateInviteDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 30)
  expiresInHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxUses?: number;

  /** true (padrão): acesso a todos os agentes; false: só os de agentIds */
  @IsOptional()
  @IsBoolean()
  allAgents?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  agentIds?: string[];
}

class EnterWithCodeDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'Digite seu nome para entrar.' })
  @MinLength(2, { message: 'Digite seu nome para entrar.' })
  @MaxLength(80, { message: 'O nome pode ter no máximo 80 caracteres.' })
  name: string;
}

/** Convites da organização ativa (dono e admins). */
@Controller('org/invites')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class OrgInvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateInviteDto) {
    return this.invites.create(user.companyId, user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.invites.list(user.companyId);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invites.revoke(user.companyId, id);
  }
}

/** Lado de quem recebe o convite (link, QR ou código digitado). */
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Public()
  @Get(':code')
  preview(@Param('code') code: string) {
    return this.invites.preview(code);
  }

  /** Entrada do evento só com o nome. Antes de `:code/enter`, que também casaria. */
  @Public()
  @Post('evento/enter')
  @HttpCode(200)
  enterEvent(@Body() dto: EnterWithCodeDto) {
    return this.invites.enterEvent(dto.name);
  }

  /** Entrada por convite: nome + código, sem conta prévia. */
  @Public()
  @Post(':code/enter')
  @HttpCode(200)
  enter(@Param('code') code: string, @Body() dto: EnterWithCodeDto) {
    return this.invites.enter(code, dto.name);
  }

  @NoOrg()
  @Post(':code/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.invites.accept(code, user.userId);
  }
}
