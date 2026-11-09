import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type {
  CaptureProvider,
  CapturedTranscript,
} from './capture-provider.interface';

/**
 * Provedor de captura via bot (aao-scribe). O worker já gravou o áudio, rodou o
 * STT e subiu a transcrição para o MinIO, gravando `transcriptKey` em
 * MeetingSession. Aqui só lemos esse objeto e o entregamos ao pipeline.
 */
@Injectable()
export class BotCaptureProvider implements CaptureProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async fetchTranscript(meetingSessionId: string): Promise<CapturedTranscript> {
    const session = await this.prisma.meetingSession.findUnique({
      where: { id: meetingSessionId },
    });
    if (!session) throw new NotFoundException('Reunião não encontrada.');
    if (!session.transcriptKey) {
      throw new Error(
        'reunião sem transcrição disponível (bot ainda não concluiu)',
      );
    }

    const buf = await this.storage.download(session.transcriptKey);
    return {
      text: buf.toString('utf-8'),
      subject: session.subject?.trim() || 'Reunião',
      startedAt: session.startedAt ?? undefined,
    };
  }
}
