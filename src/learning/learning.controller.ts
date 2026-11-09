import {
  BadGatewayException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { BridgeService } from '../conversations/bridge.service';

/**
 * Governança dos aprendizados (skills do Hermes) dos agentes do tenant.
 * Só leitura + arquivamento — o conteúdo é criado pelos próprios agentes.
 */
@Controller('learning')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class LearningController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('skills')
  async list(@CurrentUser() user: AuthUser) {
    try {
      return await this.bridge.listSkills(user.companyId);
    } catch {
      throw new BadGatewayException(
        'Não foi possível consultar os aprendizados (bridge indisponível).',
      );
    }
  }

  @Post('skills/:name/archive')
  async archive(@CurrentUser() user: AuthUser, @Param('name') name: string) {
    try {
      await this.bridge.archiveSkill(user.companyId, name);
      return { archived: true };
    } catch (err) {
      if ((err as Error).message.includes('não encontrada')) {
        throw new NotFoundException('Habilidade não encontrada');
      }
      throw new BadGatewayException(
        'Não foi possível arquivar (bridge indisponível).',
      );
    }
  }
}
