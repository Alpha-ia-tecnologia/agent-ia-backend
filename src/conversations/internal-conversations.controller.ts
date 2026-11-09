import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { ConversationsService } from './conversations.service';

/**
 * Chamado pelo Hermes (ferramenta especialista_acionar do Gerente): roda o
 * turno de um especialista dentro do turno do Gerente.
 */
@Controller('internal/conversations')
@UseGuards(BridgeKeyGuard)
export class InternalConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post('especialista')
  @Public()
  especialista(
    @Query('companyId') companyId: string,
    @Query('conversationId') conversationId: string,
    @Query('requesterId') requesterId: string,
    @Body() body: { especialista?: string; tarefa?: string },
  ) {
    return this.conversations.runSpecialist(
      companyId,
      conversationId,
      requesterId,
      body?.especialista,
      body?.tarefa,
    );
  }
}
