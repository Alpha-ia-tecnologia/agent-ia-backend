import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  MeetingsService,
  type CreateMeetingDto,
  type MeetingChannelDto,
} from './meetings.service';

@Controller('meetings')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class MeetingsController {
  constructor(private readonly service: MeetingsService) {}

  // ---- Canal (declarado antes das rotas :id para não colidir) ----

  @Get('channels')
  listChannels(@CurrentUser() user: AuthUser) {
    return this.service.listChannels(user.companyId);
  }

  @Post('channels')
  createChannel(@CurrentUser() user: AuthUser, @Body() dto: MeetingChannelDto) {
    return this.service.createChannel(user.companyId, dto);
  }

  @Patch('channels/:id')
  updateChannel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MeetingChannelDto,
  ) {
    return this.service.updateChannel(user.companyId, id, dto);
  }

  // ---- Reuniões ----

  /** Cola o link (entrar agora) ou agenda (scheduledAt no futuro). */
  @Post()
  createMeeting(@CurrentUser() user: AuthUser, @Body() dto: CreateMeetingDto) {
    return this.service.createMeeting(user.companyId, dto);
  }

  @Get()
  listMeetings(@CurrentUser() user: AuthUser) {
    return this.service.listMeetings(user.companyId);
  }

  @Get(':id')
  getMeeting(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getMeeting(user.companyId, id);
  }

  /** Transcrição carimbada da reunião. */
  @Get(':id/transcript')
  getTranscript(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getTranscript(user.companyId, id);
  }

  /**
   * Streaming da gravação de áudio. O <audio> do navegador não manda header de
   * auth, então o token vai por query (?token=), que o JwtStrategy também aceita.
   */
  @Get(':id/recording')
  async getRecording(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const stream = await this.service.streamRecording(user.companyId, id);
    res.setHeader('Content-Type', 'audio/ogg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    stream.pipe(res);
  }

  /** Faz o bot sair da reunião agora e transcrever o que já foi gravado. */
  @Post(':id/stop')
  stopMeeting(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.stopMeeting(user.companyId, id);
  }

  /** Cancela uma reunião ainda não iniciada. */
  @Delete(':id')
  cancelMeeting(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.cancelMeeting(user.companyId, id);
  }

  /** Remove a reunião do histórico (soft delete). */
  @Post(':id/remove')
  removeMeeting(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.removeMeeting(user.companyId, id);
  }
}
