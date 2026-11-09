import {
  Delete,
  Patch,
  Body,
  Controller,
  Get,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  endWith,
  ignoreElements,
  interval,
  map,
  merge,
  Observable,
  share,
  takeUntil,
} from 'rxjs';
import type { BridgeEvent } from './bridge.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { ConversationStreamService } from './conversation-stream.service';
import { ConversationsService } from './conversations.service';
import {
  CreateConversationDto,
  ResolveShareRequestDto,
  SendMessageDto,
  ShareConversationDto,
  UpdateConversationDto,
} from './dto/conversation.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly service: ConversationsService,
    private readonly stream: ConversationStreamService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return this.service.create(
      user.companyId,
      user.userId,
      dto.title,
      dto.projectId,
    );
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query('scope') scope?: string) {
    void this.service.warmTenant(user.companyId);
    return this.service.findAll(
      user.companyId,
      { userId: user.userId, role: user.role },
      scope === 'all' ? 'all' : undefined,
    );
  }

  // Rotas de solicitação de compartilhamento (declaradas antes de :id para não
  // colidir com PATCH :id).
  @Get('share-requests')
  listShareRequests(@CurrentUser() user: AuthUser) {
    return this.service.listShareRequests(user.companyId, user.userId);
  }

  @Patch('share-requests/:reqId')
  resolveShareRequest(
    @CurrentUser() user: AuthUser,
    @Param('reqId') reqId: string,
    @Body() dto: ResolveShareRequestDto,
  ) {
    return this.service.resolveShareRequest(
      user.companyId,
      user.userId,
      reqId,
      dto.action,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.service.update(user.companyId, user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, user.userId, id);
  }

  @Get(':id/share')
  async shareState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    // exige acesso de leitura antes de expor dono/participantes
    await this.service.getReadable(
      user.companyId,
      { userId: user.userId, role: user.role },
      id,
    );
    return this.service.getShareState(user.companyId, id);
  }

  @Patch(':id/share')
  share(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareConversationDto,
  ) {
    return this.service.share(user.companyId, user.userId, id, dto);
  }

  @Post(':id/share-request')
  requestShare(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.requestShare(
      user.companyId,
      { userId: user.userId, role: user.role },
      id,
    );
  }

  @Get(':id/messages')
  getMessages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getMessages(
      user.companyId,
      { userId: user.userId, role: user.role },
      id,
    );
  }

  @Post(':id/messages')
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.service.sendMessage(
      user.companyId,
      user.userId,
      id,
      dto,
      user.role,
    );
  }

  @Post(':id/files')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.uploadFile(
      user.companyId,
      { userId: user.userId, role: user.role },
      id,
      file,
    );
  }

  @Sse(':id/stream')
  async streamEvents(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    await this.service.getReadable(
      user.companyId,
      { userId: user.userId, role: user.role },
      id,
    );
    const events$ = this.stream.observe(id).pipe(share());
    // ping a cada 15 s: proxies não derrubam a conexão ociosa e a web sabe
    // que o turno segue vivo (ex.: enquanto um especialista trabalha)
    const ping$ = interval(15_000).pipe(
      map((): BridgeEvent => ({ type: 'ping' })),
      takeUntil(events$.pipe(ignoreElements(), endWith(true))),
    );
    return merge(events$, ping$).pipe(
      // Sem `type`: eventos nomeados de SSE não disparam o onmessage do
      // EventSource no navegador — o tipo já vai dentro do payload.
      map((event): MessageEvent => ({ data: event })),
    );
  }
}
