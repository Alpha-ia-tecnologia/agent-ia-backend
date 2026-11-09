import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { BotCaptureProvider } from './bot-capture.provider';
import { CAPTURE_PROVIDER } from './capture-provider.interface';
import { InternalMeetingAccountsController } from './internal-meeting-accounts.controller';
import { MeetingBotAccountsController } from './meeting-bot-accounts.controller';
import { MeetingBotAccountsService } from './meeting-bot-accounts.service';
import { MeetingHighlightsService } from './meeting-highlights.service';
import { MeetingsConfig } from './meetings.config';
import { MeetingsController } from './meetings.controller';
import { MeetingProcessingService } from './meeting-processing.service';
import { MeetingsQueueService } from './meetings-queue.service';
import { MeetingsSchedulerService } from './meetings-scheduler.service';
import { MeetingsService } from './meetings.service';

/**
 * Reuniões por link (bot aao-scribe). O usuário cola o link; enfileiramos o job
 * do bot na fila "meeting-bot" (o aao-scribe entra, grava e transcreve) e
 * consumimos "meeting-process" para rodar o agente do canal e gerar as entregas
 * via CaptureProvider (BotCaptureProvider lê a transcrição do MinIO).
 */
@Module({
  imports: [ConversationsModule, OnboardingModule],
  controllers: [
    // As rotas /meetings/accounts precisam ser registradas ANTES do
    // MeetingsController, senão o /meetings/:id captura /meetings/accounts.
    MeetingBotAccountsController,
    InternalMeetingAccountsController,
    MeetingsController,
  ],
  providers: [
    MeetingsConfig,
    MeetingsService,
    MeetingBotAccountsService,
    MeetingProcessingService,
    MeetingHighlightsService,
    MeetingsQueueService,
    MeetingsSchedulerService,
    BotCaptureProvider,
    { provide: CAPTURE_PROVIDER, useExisting: BotCaptureProvider },
  ],
})
export class MeetingsModule {}
