import { Body, Controller, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { OnboardingService } from './onboarding.service';

class ConfirmAgentDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsString()
  avatarSeed?: string;
}

class ConfirmDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConfirmAgentDto)
  agents: ConfirmAgentDto[];
}

class GenerateAgentDto {
  @IsString()
  @IsNotEmpty()
  description: string;
}

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  /** Gera sugestão de agente(s) por IA a partir de descrição livre. */
  @Post('generate-agent')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  generateAgent(@CurrentUser() user: AuthUser, @Body() dto: GenerateAgentDto) {
    return this.service.generateAgentDraft(user.companyId, dto.description);
  }

  /** Cria agentes a partir das sugestões aprovadas pelo usuário. */
  @Post('confirm-agent')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async confirmAgent(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDto) {
    const created: Awaited<
      ReturnType<OnboardingService['createFromSuggestion']>
    >[] = [];
    for (const a of dto.agents) {
      created.push(
        await this.service.createFromSuggestion(user.companyId, {
          name: a.name,
          role: a.role ?? '',
          department: a.department ?? '',
          systemPrompt: a.systemPrompt ?? '',
          avatarSeed: a.avatarSeed ?? '',
        }),
      );
    }
    return { agents: created };
  }

  @Post('generate')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  generate(@CurrentUser() user: AuthUser) {
    return this.service.generate(user.companyId);
  }

  @Post('confirm')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDto) {
    return this.service.confirm(
      user.companyId,
      dto.agents.map((a) => ({
        name: a.name,
        role: a.role ?? '',
        department: a.department ?? 'Geral',
        systemPrompt: a.systemPrompt ?? '',
        avatarSeed: a.avatarSeed ?? '',
      })),
    );
  }
}
