import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MeetingsConfig } from './meetings.config';
import { MeetingsService } from './meetings.service';

/**
 * Varredor de reuniões agendadas. A cada tick, enfileira as reuniões cujo
 * `scheduledAt` já venceu e que ainda estão PENDING. Usa setInterval em vez de
 * @nestjs/schedule para não adicionar dependência (mesma escolha das outras
 * rotinas do projeto). O enqueue move o status para JOINING, então uma reunião
 * não é enfileirada duas vezes.
 */
@Injectable()
export class MeetingsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingsSchedulerService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meetings: MeetingsService,
    private readonly cfg: MeetingsConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.cfg.schedulerIntervalMs,
    );
    if (this.timer.unref) this.timer.unref();
  }

  private async tick(): Promise<void> {
    let due: Array<{ id: string }>;
    try {
      due = await this.prisma.meetingSession.findMany({
        where: {
          status: 'PENDING',
          scheduledAt: { not: null, lte: new Date() },
        },
        select: { id: true },
        take: 20,
      });
    } catch (err) {
      this.logger.warn(
        `falha ao buscar reuniões agendadas: ${(err as Error).message}`,
      );
      return;
    }

    for (const m of due) {
      try {
        await this.meetings.enqueue(m.id);
        this.logger.log(`reunião agendada enfileirada: ${m.id}`);
      } catch (err) {
        this.logger.warn(
          `falha ao enfileirar ${m.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
