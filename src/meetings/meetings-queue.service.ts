import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { MeetingsConfig } from './meetings.config';
import { MeetingProcessingService } from './meeting-processing.service';

/** Payload enfileirado para o aao-scribe entrar e gravar a reunião. */
export interface BotJobData {
  meetingSessionId: string;
  companyId: string;
  joinUrl: string;
  platform: 'TEAMS' | 'MEET';
  guestName?: string;
  /** Aviso de consentimento a postar no chat ao entrar; ausente = não anuncia. */
  announce?: string;
  maxDurationSec?: number;
  /** Conta do escritório (MeetingBotAccount) para o bot entrar logado. */
  botAccountId?: string;
}

/**
 * Ponte de filas com o aao-scribe (BullMQ + Redis):
 *  - PRODUZ na fila "meeting-bot": o worker do aao-scribe consome, entra na
 *    reunião, grava e transcreve.
 *  - CONSOME a fila "meeting-process": o aao-scribe publica aqui quando a
 *    transcrição está pronta; rodamos o agente do canal e geramos as entregas.
 */
@Injectable()
export class MeetingsQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingsQueueService.name);
  private botQueue!: Queue;
  private processWorker!: Worker;
  private queueConn!: Redis;
  private workerConn!: Redis;

  constructor(
    private readonly cfg: MeetingsConfig,
    private readonly processing: MeetingProcessingService,
  ) {}

  onModuleInit(): void {
    const opts = {
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    } as const;
    this.queueConn = new IORedis(this.cfg.redisUrl, opts);
    this.workerConn = new IORedis(this.cfg.redisUrl, opts);

    let lastLog = 0;
    const onError = (err: Error) => {
      const now = Date.now();
      if (now - lastLog > 30_000) {
        lastLog = now;
        this.logger.warn(`conexão Redis indisponível: ${err.message}`);
      }
    };
    this.queueConn.on('error', onError);
    this.workerConn.on('error', onError);

    this.botQueue = new Queue(this.cfg.botQueueName, {
      connection: this.queueConn as unknown as ConnectionOptions,
    });

    this.processWorker = new Worker(
      this.cfg.processQueueName,
      (job) =>
        this.processing.process(
          (job.data as { meetingSessionId: string }).meetingSessionId,
        ),
      {
        connection: this.workerConn as unknown as ConnectionOptions,
        concurrency: 4,
      },
    );
    this.processWorker.on('failed', (job, err) => {
      this.logger.warn(
        `process job ${job?.id} falhou (tentativa ${job?.attemptsMade}): ${err.message}`,
      );
    });
  }

  /**
   * Enfileira uma reunião para o bot. jobId determinístico garante idempotência
   * (não entra duas vezes na mesma reunião enquanto o job estiver na fila).
   */
  async enqueueBotJob(data: BotJobData): Promise<void> {
    await this.botQueue.add('join-meeting', data, {
      jobId: `bot-${data.meetingSessionId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: true,
      removeOnFail: 200,
    });
  }

  /**
   * Sinaliza parada manual ao aao-scribe: o loop do bot vê a chave, sai da
   * reunião e segue com a transcrição do que já foi gravado. TTL de 1h cobre
   * o caso de a chave ficar órfã (bot já saiu por outro motivo).
   */
  async requestStop(meetingSessionId: string): Promise<void> {
    await this.queueConn.set(
      `meeting:stop:${meetingSessionId}`,
      '1',
      'EX',
      3600,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.processWorker?.close().catch(() => undefined);
    await this.botQueue?.close().catch(() => undefined);
    this.queueConn?.disconnect();
    this.workerConn?.disconnect();
  }
}
