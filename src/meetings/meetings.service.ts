import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { detectPlatform } from './platform';
import {
  MeetingBotAccountsService,
  providerForPlatform,
} from './meeting-bot-accounts.service';
import { MeetingsConfig } from './meetings.config';
import { MeetingsQueueService } from './meetings-queue.service';

/** Configuração de uma entrega pós-reunião (guardada em Channel.config). */
export interface MeetingDelivery {
  type?: string;
  format?: string;
  instruction?: string;
}

/** Consentimento de gravação anunciado no chat da reunião. */
export interface MeetingConsent {
  /** Postar o aviso no chat ao entrar? (default: true) */
  announce?: boolean;
  /** Texto do aviso; vazio = mensagem padrão. */
  message?: string;
}

/** Forma do Channel.config de um canal de reuniões. */
interface MeetingChannelConfig {
  deliveries?: MeetingDelivery[];
  /** Nome exibido do bot na reunião. */
  botName?: string;
  consent?: MeetingConsent;
}

export interface MeetingChannelDto {
  name?: string;
  agentId?: string | null;
  isActive?: boolean;
  autoRespond?: boolean;
  deliveries?: MeetingDelivery[];
  botName?: string;
  consent?: MeetingConsent;
}

export interface CreateMeetingDto {
  joinUrl: string;
  subject?: string;
  /** ISO; ausente/no passado = entrar assim que possível. */
  scheduledAt?: string;
  /** Canal de reuniões a usar; ausente = o canal MEETINGS ativo da empresa. */
  channelId?: string;
}

const CHANNEL_TYPE = 'MEETINGS';
const LIVE_STATUSES = [
  'PENDING',
  'JOINING',
  'LOBBY',
  'RECORDING',
  'LEFT',
  'TRANSCRIBING',
  'PROCESSING',
];

/**
 * Reuniões por link: cria a MeetingSession, resolve a plataforma pelo link,
 * enfileira o bot (imediato) ou deixa para o scheduler (agendado), e expõe o
 * histórico. A configuração do canal (agente + entregas) vive no modelo Channel,
 * no mesmo padrão dos demais canais.
 */
@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MeetingsQueueService,
    private readonly storage: StorageService,
    private readonly cfg: MeetingsConfig,
    private readonly botAccounts: MeetingBotAccountsService,
  ) {}

  // ---- Canal (agente responsável + entregas) ----

  listChannels(companyId: string) {
    return this.prisma.channel.findMany({
      where: { companyId, type: CHANNEL_TYPE, removedAt: null },
      select: {
        id: true,
        name: true,
        agentId: true,
        isActive: true,
        autoRespond: true,
        config: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  createChannel(companyId: string, dto: MeetingChannelDto) {
    const config: MeetingChannelConfig = {
      deliveries: dto.deliveries ?? [],
      ...(dto.botName !== undefined ? { botName: dto.botName.trim() } : {}),
      ...(dto.consent !== undefined ? { consent: dto.consent } : {}),
    };
    return this.prisma.channel.create({
      data: {
        companyId,
        type: CHANNEL_TYPE,
        name: dto.name?.trim() || 'Reuniões',
        agentId: dto.agentId || null,
        autoRespond: dto.autoRespond ?? true,
        encryptedToken: '',
        iv: '',
        authTag: '',
        config: config as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, name: true, agentId: true, config: true },
    });
  }

  async updateChannel(companyId: string, id: string, dto: MeetingChannelDto) {
    const ch = await this.prisma.channel.findFirst({
      where: { id, companyId, type: CHANNEL_TYPE },
    });
    if (!ch) throw new NotFoundException('Canal não encontrado.');

    const config = { ...((ch.config as object) ?? {}) } as MeetingChannelConfig;
    if (dto.deliveries !== undefined) config.deliveries = dto.deliveries;
    if (dto.botName !== undefined) config.botName = dto.botName.trim();
    if (dto.consent !== undefined) config.consent = dto.consent;

    return this.prisma.channel.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.agentId !== undefined ? { agentId: dto.agentId || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.autoRespond !== undefined
          ? { autoRespond: dto.autoRespond }
          : {}),
        config: config as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        name: true,
        agentId: true,
        isActive: true,
        autoRespond: true,
        config: true,
      },
    });
  }

  // ---- Reuniões ----

  async createMeeting(companyId: string, dto: CreateMeetingDto) {
    const platform = detectPlatform(dto.joinUrl);
    if (!platform) {
      throw new BadRequestException(
        'Link inválido. Aceitamos reuniões do Microsoft Teams ou Google Meet.',
      );
    }

    // Gating: a empresa precisa ter a conta do provedor conectada (Google/Meet
    // hoje). Lança BadRequest com instrução clara se faltar — antes de criar a
    // sessão, para não deixar reunião fadada a ser recusada pelo Google.
    await this.botAccounts.requireForPlatform(companyId, platform);

    const channel = dto.channelId
      ? await this.prisma.channel.findFirst({
          where: {
            id: dto.channelId,
            companyId,
            type: CHANNEL_TYPE,
            removedAt: null,
          },
        })
      : await this.prisma.channel.findFirst({
          where: {
            companyId,
            type: CHANNEL_TYPE,
            removedAt: null,
            isActive: true,
          },
          orderBy: { createdAt: 'desc' },
        });
    if (!channel) {
      throw new BadRequestException(
        'Configure um canal de reuniões (agente + entregas) antes de agendar.',
      );
    }

    // Anti-flood: limita reuniões simultâneas em andamento por empresa.
    const active = await this.prisma.meetingSession.count({
      where: { companyId, status: { in: LIVE_STATUSES } },
    });
    if (active >= this.cfg.maxConcurrentPerCompany) {
      throw new ConflictException(
        `Limite de ${this.cfg.maxConcurrentPerCompany} reuniões simultâneas atingido. Aguarde as atuais concluírem.`,
      );
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const isFuture = scheduledAt !== null && scheduledAt.getTime() > Date.now();

    const session = await this.prisma.meetingSession.create({
      data: {
        companyId,
        channelId: channel.id,
        platform,
        joinUrl: dto.joinUrl.trim(),
        subject: dto.subject?.trim() || '',
        scheduledAt,
        status: 'PENDING',
      },
    });

    // Imediato: enfileira agora e marca JOINING (o scheduler só pega PENDING).
    if (!isFuture) await this.enqueue(session.id);

    return session;
  }

  /**
   * Enfileira o job do bot para uma reunião. Carrega o canal para derivar o nome
   * exibido do bot e o aviso de consentimento, e move o status para JOINING
   * (o scheduler só pega PENDING, então não re-enfileira).
   */
  async enqueue(meetingSessionId: string): Promise<void> {
    const session = await this.prisma.meetingSession.findUnique({
      where: { id: meetingSessionId },
    });
    if (!session) throw new NotFoundException('Reunião não encontrada.');

    const channel = await this.prisma.channel.findUnique({
      where: { id: session.channelId },
    });
    const config = (channel?.config ?? {}) as MeetingChannelConfig;
    const guestName = config.botName?.trim() || this.cfg.defaultBotName;
    const announce =
      config.consent?.announce === false
        ? undefined
        : config.consent?.message?.trim() || this.cfg.defaultConsentMessage;

    // Conta do escritório para o bot entrar logado (Google/Microsoft). Anexada
    // ao job para o worker buscar o storageState pelo endpoint interno.
    const platform = session.platform as 'TEAMS' | 'MEET';
    const account = await this.botAccounts.findConnected(
      session.companyId,
      providerForPlatform(platform),
    );

    await this.queue.enqueueBotJob({
      meetingSessionId,
      companyId: session.companyId,
      joinUrl: session.joinUrl,
      platform,
      guestName,
      ...(announce ? { announce } : {}),
      ...(account ? { botAccountId: account.id } : {}),
    });
    await this.prisma.meetingSession.update({
      where: { id: meetingSessionId },
      data: { status: 'JOINING' },
    });
  }

  listMeetings(companyId: string) {
    return this.prisma.meetingSession.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Exclui a reunião do histórico (delete real) e limpa a gravação/transcrição
   * no MinIO. A restrição de quem pode excluir virá com o módulo de permissões.
   */
  async removeMeeting(companyId: string, id: string) {
    const session = await this.getMeeting(companyId, id);
    if (session.recordingKey)
      await this.storage.remove(session.recordingKey).catch(() => undefined);
    if (session.transcriptKey)
      await this.storage.remove(session.transcriptKey).catch(() => undefined);
    await this.prisma.meetingSession.delete({ where: { id: session.id } });
    return { ok: true };
  }

  async getMeeting(companyId: string, id: string) {
    const session = await this.prisma.meetingSession.findFirst({
      where: { id, companyId },
    });
    if (!session) throw new NotFoundException('Reunião não encontrada.');
    return session;
  }

  /** Stream de áudio da gravação (servido pelo controller com ?token=). */
  async streamRecording(companyId: string, id: string) {
    const session = await this.getMeeting(companyId, id);
    if (!session.recordingKey)
      throw new NotFoundException('Reunião sem gravação.');
    return this.storage.getStream(session.recordingKey);
  }

  /** Texto da transcrição (carimbada). */
  async getTranscript(
    companyId: string,
    id: string,
  ): Promise<{ text: string }> {
    const session = await this.getMeeting(companyId, id);
    if (!session.transcriptKey)
      throw new NotFoundException('Reunião sem transcrição.');
    const buf = await this.storage.download(session.transcriptKey);
    return { text: buf.toString('utf-8') };
  }

  /**
   * Parada manual: sinaliza o bot para sair da reunião e transcrever o que já
   * foi gravado. Só faz sentido com o bot dentro (ou entrando) da reunião.
   */
  async stopMeeting(companyId: string, id: string) {
    const session = await this.getMeeting(companyId, id);
    if (!['JOINING', 'LOBBY', 'RECORDING'].includes(session.status)) {
      throw new BadRequestException('O bot não está em uma reunião ativa.');
    }
    await this.queue.requestStop(id);
    return { ok: true as const };
  }

  /** Cancela uma reunião ainda não iniciada (PENDING/JOINING/LOBBY). */
  async cancelMeeting(companyId: string, id: string) {
    const session = await this.getMeeting(companyId, id);
    if (['DONE', 'PROCESSING', 'TRANSCRIBING'].includes(session.status)) {
      throw new BadRequestException(
        'Reunião já em processamento; não pode ser cancelada.',
      );
    }
    return this.prisma.meetingSession.update({
      where: { id },
      data: { status: 'FAILED', error: 'cancelada pelo usuário' },
    });
  }
}
