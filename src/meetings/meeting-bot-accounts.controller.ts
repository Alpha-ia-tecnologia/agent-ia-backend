import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  MeetingBotAccountsService,
  type BotProvider,
  type ConnectBotAccountDto,
} from './meeting-bot-accounts.service';

/**
 * Contas Google/Microsoft do escritório para o bot entrar logado nas reuniões.
 * Só OWNER/ADMIN. O storageState nunca é devolvido ao cliente (só status).
 */
@Controller('meetings/accounts')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class MeetingBotAccountsController {
  constructor(private readonly service: MeetingBotAccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.companyId);
  }

  /** Onboarding assistido / fallback: recebe o storageState (upload) direto. */
  @Post()
  connect(@CurrentUser() user: AuthUser, @Body() dto: ConnectBotAccountDto) {
    return this.service.connect(user.companyId, dto);
  }

  // --- Login hospedado (browser streamado, sem terminal) ---

  /** Abre a sessão de login e devolve ao painel o WS + token único. */
  @Post('connect-session')
  startConnectSession(@Body() body: { provider: BotProvider }) {
    return this.service.startConnectSession(body.provider);
  }

  /** Captura a sessão logada e salva a conta do escritório. */
  @Post('connect-session/finish')
  finishConnectSession(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      sessionId: string;
      token: string;
      provider: BotProvider;
      email?: string;
    },
  ) {
    return this.service.finishConnectSession(
      user.companyId,
      body.sessionId,
      body.token,
      body.provider,
      body.email,
    );
  }

  /** Cancela/derruba a sessão de login. */
  @Post('connect-session/cancel')
  async cancelConnectSession(@Body() body: { sessionId: string }) {
    await this.service.cancelConnectSession(body.sessionId);
    return { ok: true };
  }

  @Delete(':id')
  disconnect(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.disconnect(user.companyId, id);
  }
}
