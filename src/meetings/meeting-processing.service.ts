import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { ConversationsService } from '../conversations/conversations.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CAPTURE_PROVIDER,
  type CaptureProvider,
} from './capture-provider.interface';
import { MeetingHighlightsService } from './meeting-highlights.service';

/** Uma entrega configurada no canal (config.deliveries[]). */
interface Delivery {
  type?: string; // Resumo | Ata | Action items | Planilha | Personalizado
  format?: string; // texto | pdf | xlsx
  instruction?: string; // prompt/template livre
}

// ~75 mil tokens: reuniões de 6h+ passam inteiras nos modelos atuais (200k de
// contexto). O corte head+tail abaixo fica só como rede de segurança para o
// caso patológico; ajuste via env se o modelo da empresa tiver contexto menor.
const MAX_TRANSCRIPT_CHARS = Number(
  process.env.MEETING_TRANSCRIPT_MAX_CHARS ?? 300_000,
);

/**
 * Limita a transcrição ao orçamento de contexto preservando início E fim — o
 * fim da reunião concentra decisões e encaminhamentos, então quem cai é um
 * trecho do meio (com marcador explícito). O corte respeita quebras de linha
 * para não partir uma fala ao meio.
 */
function clipTranscript(transcript: string): {
  clipped: string;
  truncated: boolean;
} {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return { clipped: transcript, truncated: false };
  }
  const headBudget = Math.floor(MAX_TRANSCRIPT_CHARS * 0.6);
  const tailBudget = MAX_TRANSCRIPT_CHARS - headBudget;

  let head = transcript.slice(0, headBudget);
  const headBreak = head.lastIndexOf('\n');
  if (headBreak > 0) head = head.slice(0, headBreak);

  let tail = transcript.slice(transcript.length - tailBudget);
  const tailBreak = tail.indexOf('\n');
  if (tailBreak >= 0) tail = tail.slice(tailBreak + 1);

  return {
    clipped: `${head}\n[... trecho omitido ...]\n${tail}`,
    truncated: true,
  };
}

/**
 * Processa uma reunião já gravada e transcrita pelo bot: busca a transcrição
 * (via CaptureProvider), cria a conversa no inbox e dispara o agente do canal
 * para gerar as entregas configuradas. Idempotente por meetingSessionId:
 * reprocessar uma reunião já concluída é no-op.
 */
@Injectable()
export class MeetingProcessingService {
  private readonly logger = new Logger(MeetingProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly highlights: MeetingHighlightsService,
    @Inject(CAPTURE_PROVIDER) private readonly capture: CaptureProvider,
  ) {}

  async process(meetingSessionId: string): Promise<void> {
    const session = await this.prisma.meetingSession.findUnique({
      where: { id: meetingSessionId },
    });
    if (!session) {
      this.logger.warn(`reunião ${meetingSessionId} não encontrada; ignorando`);
      return;
    }
    if (session.status === 'DONE') return; // idempotência

    const channel = await this.prisma.channel.findFirst({
      where: {
        id: session.channelId,
        companyId: session.companyId,
        removedAt: null,
      },
    });
    if (!channel || !channel.isActive) {
      this.logger.debug(
        `canal de reuniões inativo/removido para ${meetingSessionId}; ignorando`,
      );
      await this.fail(
        meetingSessionId,
        'canal de reuniões inativo ou removido',
      );
      return;
    }

    try {
      const transcript = await this.capture.fetchTranscript(meetingSessionId);
      if (!transcript.text.trim()) throw new Error('transcrição vazia');

      // Highlights (best-effort): não podem derrubar o processamento. A
      // transcrição vem carimbada ([HH:MM:SS] Falante: fala), então cada ponto
      // ganha um instante clicável.
      let highlights: Prisma.InputJsonValue | undefined;
      try {
        const extracted = await this.highlights.extract(
          session.companyId,
          transcript.subject,
          transcript.text,
        );
        if (extracted.length)
          highlights = extracted as unknown as Prisma.InputJsonValue;
      } catch (err) {
        this.logger.warn(
          `highlights falharam para ${meetingSessionId}: ${(err as Error).message}`,
        );
      }

      const owner = (
        await this.prisma.membership.findFirst({
          where: { companyId: session.companyId, role: UserRole.OWNER },
          select: { user: true },
        })
      )?.user;
      if (!owner) throw new Error('empresa sem OWNER para receber a conversa');

      // conversa + contato no inbox (reunião = contato, igual aos outros canais).
      // Num retry do BullMQ a conversa já pode existir — reutiliza em vez de
      // duplicar no inbox.
      let conversationId = session.conversationId;
      if (!conversationId) {
        const conversation = await this.prisma.conversation.create({
          data: {
            companyId: session.companyId,
            userId: owner.id,
            title: `Reunião · ${transcript.subject}`,
            metadata: {
              channel: 'meetings',
              platform: session.platform,
              meetingSessionId,
            },
          },
        });
        conversationId = conversation.id;
        await this.prisma.meetingSession.update({
          where: { id: meetingSessionId },
          data: { conversationId },
        });
        const contact = await this.prisma.channelContact.create({
          data: {
            channelId: channel.id,
            externalId: meetingSessionId,
            name: transcript.subject,
            conversationId,
          },
        });

        await this.prisma.channelMessage
          .create({
            data: {
              contactId: contact.id,
              direction: 'IN',
              content: `Transcrição recebida: ${transcript.subject}`,
            },
          })
          .catch(() => undefined);
      }

      // Agente que gera as entregas: o do canal; senão o gerente da empresa;
      // senão o primeiro ativo. Sem nenhum, não há quem produzir resumo/ata.
      const agentId =
        channel.agentId ??
        (await this.resolveDefaultAgentId(session.companyId));
      if (!agentId) {
        throw new Error(
          'Nenhum agente disponível para gerar as entregas. Configure um agente responsável no canal de reuniões.',
        );
      }

      const prompt = this.buildPrompt(
        channel.config,
        transcript.subject,
        transcript.text,
      );
      await this.conversations.sendMessage(
        session.companyId,
        owner.id,
        conversationId,
        { content: prompt, agentId },
        UserRole.OWNER,
      );

      await this.prisma.meetingSession.update({
        where: { id: meetingSessionId },
        data: {
          status: 'DONE',
          conversationId,
          subject: transcript.subject,
          startedAt: transcript.startedAt ?? session.startedAt,
          ...(highlights !== undefined ? { highlights } : {}),
        },
      });
      this.logger.log(
        `reunião processada: ${transcript.subject} (company ${session.companyId})`,
      );
    } catch (err) {
      await this.fail(meetingSessionId, (err as Error).message);
      throw err; // deixa o BullMQ aplicar retry/backoff
    }
  }

  /** Agente padrão quando o canal não tem um: gerente da empresa, senão o 1º ativo. */
  private async resolveDefaultAgentId(
    companyId: string,
  ): Promise<string | null> {
    const manager = await this.prisma.agent.findFirst({
      where: { companyId, isActive: true, isManager: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (manager) return manager.id;
    const anyAgent = await this.prisma.agent.findFirst({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return anyAgent?.id ?? null;
  }

  private async fail(id: string, message: string): Promise<void> {
    await this.prisma.meetingSession
      .update({
        where: { id },
        data: { status: 'FAILED', error: message.slice(0, 500) },
      })
      .catch(() => undefined);
  }

  /**
   * Monta o prompt do agente a partir das entregas configuradas no canal. Sem
   * entregas, cai num resumo padrão. O agente usa as tools existentes
   * (relatorio_pdf, exportar_dataset) para materializar cada entrega.
   */
  private buildPrompt(
    config: unknown,
    subject: string,
    transcript: string,
  ): string {
    const deliveries = (
      (config as { deliveries?: Delivery[] })?.deliveries ?? []
    ).filter((d) => d && (d.type || d.instruction));
    const { clipped, truncated } = clipTranscript(transcript);

    const tarefas = deliveries.length
      ? deliveries
          .map((d, i) => {
            const fmt = d.format ? ` (formato: ${d.format})` : '';
            const instr = d.instruction ? ` — ${d.instruction}` : '';
            return `${i + 1}. ${d.type ?? 'Entrega'}${fmt}${instr}`;
          })
          .join('\n')
      : '1. Resumo executivo da reunião com principais decisões e próximos passos.';

    return [
      `Você recebeu a transcrição da reunião "${subject}".`,
      `Produza as seguintes entregas:`,
      tarefas,
      '',
      'Como produzir cada entrega:',
      '- Formato PDF: chame a ferramenta relatorio_pdf (uma chamada por entrega,',
      '  com o conteúdo completo em Markdown). O documento aparece na conversa',
      '  com botão de download.',
      '- Formato texto (ou sem formato): escreva o conteúdo completo diretamente',
      '  na sua resposta.',
      '- Formato planilha/xlsx: use a ferramenta de exportação de dados.',
      '',
      'Este é um fluxo automático: produza TODAS as entregas agora, mesmo que a',
      'transcrição esteja incompleta, ruidosa ou com trechos marcados como [Música].',
      'Nunca responda pedindo uma transcrição melhor nem condicione a entrega a',
      'informações adicionais. Se a qualidade limitar o conteúdo, gere a entrega',
      'com o que houver e registre a limitação em uma nota dentro dela.',
      ...(truncated
        ? [
            '',
            'ATENÇÃO: a reunião foi longa e a transcrição abaixo foi TRUNCADA — ela',
            'contém o início e o fim da reunião, com um trecho do meio omitido (marcado',
            'com [... trecho omitido ...]). Registre essa limitação nas entregas.',
          ]
        : []),
      '',
      'Transcrição:',
      '"""',
      clipped,
      '"""',
    ].join('\n');
  }
}
