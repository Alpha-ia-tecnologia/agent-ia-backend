import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { UseGuards } from '@nestjs/common';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { ChannelsService } from './channels.service';

@Controller('channels')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class ChannelsController {
  constructor(private readonly service: ChannelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.companyId);
  }

  @Post('telegram')
  createTelegram(
    @CurrentUser() user: AuthUser,
    @Body() dto: { token?: string; agentId?: string },
  ) {
    if (!dto.token?.trim())
      throw new BadRequestException('Informe o token do bot.');
    return this.service.createTelegram(
      user.companyId,
      dto.token.trim(),
      dto.agentId,
    );
  }

  @Post('email')
  createEmail(
    @CurrentUser() user: AuthUser,
    @Body()
    dto: {
      address?: string;
      password?: string;
      imapHost?: string;
      imapPort?: number;
      smtpHost?: string;
      smtpPort?: number;
      agentId?: string;
    },
  ) {
    for (const field of [
      'address',
      'password',
      'imapHost',
      'smtpHost',
    ] as const) {
      if (!dto[field]?.toString().trim()) {
        throw new BadRequestException(`Campo obrigatório: ${field}`);
      }
    }
    return this.service.createEmail(user.companyId, {
      address: dto.address!,
      password: dto.password!,
      imapHost: dto.imapHost!,
      imapPort: dto.imapPort ?? 993,
      smtpHost: dto.smtpHost!,
      smtpPort: dto.smtpPort ?? 587,
      agentId: dto.agentId,
    });
  }

  @Post('whatsapp')
  createWhatsApp(
    @CurrentUser() user: AuthUser,
    @Body() dto: { agentId?: string },
  ) {
    return this.service.createWhatsApp(user.companyId, dto?.agentId);
  }

  @Get(':id/whatsapp-status')
  whatsappStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.whatsappStatus(user.companyId, id);
  }

  @Get('inbox/contacts')
  inboxContacts(@CurrentUser() user: AuthUser, @Query('type') type?: string) {
    return this.service.inboxContacts(user.companyId, type || undefined);
  }

  @Get('inbox/contacts/:id/messages')
  inboxMessages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.inboxMessages(user.companyId, id);
  }

  @Post('inbox/contacts/:id/reply')
  inboxReply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: { content?: string },
  ) {
    if (!dto.content?.trim()) throw new BadRequestException('Mensagem vazia');
    return this.service.inboxReply(
      user.companyId,
      id,
      dto.content.trim(),
      user.email,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body()
    dto: { isActive?: boolean; agentId?: string | null; autoRespond?: boolean },
  ) {
    return this.service.update(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }
}

/** Consumido pelas tools dos agentes (via bridge). Só leitura. */
@Controller('internal/channels')
@UseGuards(BridgeKeyGuard)
export class InternalChannelsController {
  constructor(private readonly service: ChannelsService) {}

  @Post('mensagens')
  @Public()
  mensagens(
    @Query('companyId') companyId: string,
    @Body()
    body: {
      canal?: string;
      contato?: string;
      limite?: number;
      direcao?: string;
    },
  ) {
    return this.service.mensagensParaAgente(companyId, body ?? {});
  }
}
