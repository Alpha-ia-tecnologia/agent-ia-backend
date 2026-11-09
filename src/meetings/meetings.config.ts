import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Configuração da integração de reuniões (bot aao-scribe).
 *
 * O aao-api apenas enfileira o job do bot (fila "meeting-bot", consumida pelo
 * aao-scribe) e consome a fila "meeting-process" que o bot devolve quando a
 * transcrição está pronta. Redis e MinIO são os mesmos dos demais serviços.
 */
@Injectable()
export class MeetingsConfig {
  constructor(private readonly config: ConfigService) {}

  get redisUrl(): string {
    return this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
  }

  /** Fila que o aao-scribe consome para entrar/gravar a reunião. */
  get botQueueName(): string {
    return this.config.get<string>('MEETING_QUEUE_NAME') ?? 'meeting-bot';
  }

  /** Fila que o aao-scribe produz quando a transcrição está pronta. */
  get processQueueName(): string {
    return (
      this.config.get<string>('MEETING_PROCESS_QUEUE_NAME') ?? 'meeting-process'
    );
  }

  /** Intervalo do varredor de reuniões agendadas (ms). */
  readonly schedulerIntervalMs = 30_000;

  /** Teto de reuniões simultâneas em andamento por empresa (anti-flood). */
  get maxConcurrentPerCompany(): number {
    return Number(this.config.get<string>('MEETING_MAX_CONCURRENT') ?? '5');
  }

  /** Nome padrão exibido do bot na reunião (deixa claro que está gravando). */
  readonly defaultBotName = 'Assistente AAO (gravando)';

  /** Aviso padrão postado no chat quando o bot entra (consentimento). */
  readonly defaultConsentMessage =
    'Olá! Sou o assistente da reunião e estou gravando e transcrevendo para gerar o resumo e as atas. Se preferir que eu saia, é só me remover.';
}
