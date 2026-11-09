import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { MeetingBotAccountsService } from './meeting-bot-accounts.service';

/**
 * Endpoint interno consumido pelo worker (aao-scribe) via x-bridge-key. Entrega
 * o storageState DECIFRADO da conta do escritório para o bot entrar logado, e
 * recebe de volta o aviso de expiração quando a sessão não vale mais. Mantém o
 * MASTER_ENCRYPTION_KEY apenas no aao-api (o worker nunca decifra nada).
 */
@Controller('internal/meeting-accounts')
export class InternalMeetingAccountsController {
  constructor(private readonly service: MeetingBotAccountsService) {}

  @Get('state')
  @Public()
  @UseGuards(BridgeKeyGuard)
  async getState(@Query('botAccountId') botAccountId: string) {
    const storageState = await this.service.getDecryptedState(botAccountId);
    return { storageState };
  }

  @Post('expired')
  @Public()
  @UseGuards(BridgeKeyGuard)
  async markExpired(@Body() body: { botAccountId: string; error?: string }) {
    await this.service.markExpired(body.botAccountId, body.error);
    return { ok: true };
  }
}
