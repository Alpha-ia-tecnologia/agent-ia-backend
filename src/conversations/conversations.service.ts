import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationVisibility,
  MessageSender,
  MessageType,
  Prisma,
  Provider,
  ShareRequestStatus,
  UserRole,
} from '@prisma/client';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { ConnectorRegistryService } from '../connector/connector-registry.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { DEFAULT_MODELS } from '../onboarding/llm-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderKeysService } from '../provider-keys/provider-keys.service';
import {
  markProviderDown,
  markProviderUp,
  orderByHealth,
  providerHealthKey,
} from '../provider-keys/provider-health';
import { ChannelDeliveryService } from '../channels/channel-delivery.service';
import { ChartService } from '../datasets/chart.service';
import { ReportService } from '../datasets/report.service';
import { StorageService } from '../storage/storage.service';
import { ToolsService } from '../tools/tools.service';
import {
  BridgeChatRequest,
  BridgeSandbox,
  BridgeService,
} from './bridge.service';
import { ConversationStreamService } from './conversation-stream.service';
import { canUseAgent, pickDefaultAgent } from '../agents/agent-access';
import { SendMessageDto } from './dto/conversation.dto';

interface AgentCapabilities {
  text_generation?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
}

/** Especialista que o Gerente acionou durante um turno (vai no metadata). */
export interface TeamMember {
  agentId: string;
  name: string;
  role: string | null;
  task: string;
  status: 'working' | 'done' | 'error';
}

/**
 * Erro do provedor de IA (não do bridge nem do conteúdo): limite, créditos,
 * chave recusada, fora do ar, sem provedor ou sem resposta a tempo. Aciona a
 * reserva. "Bridge inacessível" fica de fora: trocar de provedor não resolve.
 */
const PROVIDER_ERROR_RE =
  /API call failed|rate.?limit|\b(401|402|403|408|429|500|502|503|504|529)\b|quota|insufficient|credit|billing|overloaded|unauthori[sz]ed|authentication|invalid.{0,20}(api.?key|token)|connection error|timed? ?out|não respondeu a tempo|No LLM provider/i;

export function isProviderError(text: string | undefined): boolean {
  if (!text || /Bridge inacessível/i.test(text)) return false;
  return PROVIDER_ERROR_RE.test(text);
}

/**
 * Resposta "final" que na verdade é a falha do provedor. Só textos curtos:
 * uma resposta longa e legítima que cite "429" ou "quota" não é descartada.
 */
export function isProviderFailureText(text: string): boolean {
  return text.length < 400 && isProviderError(text);
}

/** Erro cru do bridge/provedor → texto que a pessoa entende e pode agir. */
export function friendlyChatError(raw: string | undefined): string {
  const text = raw ?? '';
  if (/No LLM provider configured|Nenhum provedor de IA/i.test(text)) {
    return 'Nenhum provedor de IA está configurado para esta organização. Um administrador precisa conectar um em Configurações → Provedores.';
  }
  if (/não respondeu a tempo|timed? ?out|timeout/i.test(text)) {
    return 'O agente demorou demais para responder. Tente de novo.';
  }
  if (
    /Bridge inacessível|Bridge retornou HTTP|ECONNREFUSED|fetch failed/i.test(
      text,
    )
  ) {
    return 'O serviço de agentes está indisponível no momento. Tente de novo em instantes.';
  }
  if (/\b429\b|rate.?limit|quota|insufficient|overloaded|\b529\b/i.test(text)) {
    return 'O provedor de IA está sobrecarregado ou sem créditos agora. Tente de novo em instantes.';
  }
  if (/\b401\b|\b403\b|invalid.*(api.?key|token)|authentication/i.test(text)) {
    return 'A chave do provedor de IA foi recusada. Um administrador precisa revisá-la em Configurações → Provedores.';
  }
  return 'Não foi possível gerar a resposta. Tente de novo.';
}

/** Quem está acessando: usado para as regras de visibilidade da conversa. */
export interface Viewer {
  userId: string;
  role: UserRole;
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  private readonly sharedDataDir: string;
  private readonly internalApiUrl: string;
  private readonly bridgeApiKey: string;
  /**
   * Turno em andamento por conversa: início (duração exibida) e especialistas
   * acionados. Em memória — a API roda numa réplica só.
   */
  private readonly turns = new Map<
    string,
    { startedAt: number; team: TeamMember[] }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerKeys: ProviderKeysService,
    private readonly channelDelivery: ChannelDeliveryService,
    private readonly chartService: ChartService,
    private readonly reportService: ReportService,
    private readonly bridge: BridgeService,
    private readonly stream: ConversationStreamService,
    private readonly storage: StorageService,
    private readonly tools: ToolsService,
    private readonly knowledge: KnowledgeService,
    private readonly connectorRegistry: ConnectorRegistryService,
    config: ConfigService,
  ) {
    this.sharedDataDir =
      config.get<string>('BRIDGE_SHARED_DATA_DIR') ??
      join(process.cwd(), '..', 'aao-hermes-bridge', 'data');
    this.internalApiUrl =
      config.get<string>('INTERNAL_API_URL') ?? 'http://localhost:3000/api';
    this.bridgeApiKey = (config.get<string>('BRIDGE_API_KEY') ?? '').trim();
  }

  async create(
    companyId: string,
    userId: string,
    title?: string,
    projectId?: string,
  ) {
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, companyId },
        select: { id: true, name: true },
      });
      if (!project) throw new NotFoundException('Projeto não encontrado');
      title ??= `Projeto: ${project.name}`;
    }
    return this.prisma.conversation.create({
      data: {
        companyId,
        userId,
        title: title ?? 'Nova conversa',
        projectId: projectId ?? null,
      },
    });
  }

  /**
   * Sobe a instância Hermes do tenant em background para eliminar o cold start
   * da primeira mensagem. Chamado quando o usuário abre o escritório.
   */
  async warmTenant(companyId: string): Promise<void> {
    try {
      const manager = await this.prisma.agent.findFirst({
        where: { companyId, isManager: true, isActive: true },
      });
      if (!manager) return;
      // provedor padrão da empresa: é o que o processo Hermes usa no config
      // (o do agente, se diferente, vale por sessão no bridge)
      const provider = await this.resolveProvider(companyId, {});
      const sandbox = this.resolveSandbox();
      void this.bridge.warmup(
        companyId,
        provider,
        manager.systemPrompt,
        sandbox,
      );
    } catch {
      // pré-aquecimento é melhor esforço; a primeira mensagem funciona sem ele
    }
  }

  async findAll(companyId: string, viewer: Viewer, scope?: 'all') {
    const isAdmin =
      viewer.role === UserRole.OWNER || viewer.role === UserRole.ADMIN;
    const where: Prisma.ConversationWhereInput =
      scope === 'all' && isAdmin
        ? { companyId }
        : {
            companyId,
            OR: [
              { userId: viewer.userId },
              { visibility: ConversationVisibility.COMPANY },
              { participants: { some: { userId: viewer.userId } } },
            ],
          };
    const conversations = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      include: {
        user: { select: { id: true, name: true } },
        participants: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    });
    // conversas vindas de canais (Telegram/e-mail/WhatsApp) vivem na área
    // de Canais, não na lista do chat
    return conversations
      .filter((c) => !(c.metadata as Record<string, unknown> | null)?.channel)
      .map((c) => this.toConversationView(c, viewer));
  }

  /** Achata dono/participantes/flags de acesso para o front. */
  private toConversationView(
    c: Prisma.ConversationGetPayload<{
      include: {
        user: { select: { id: true; name: true } };
        participants: {
          select: { user: { select: { id: true; name: true } } };
        };
      };
    }>,
    viewer: Viewer,
  ) {
    const isOwner = c.userId === viewer.userId;
    const participants = c.participants.map((p) => p.user);
    const isParticipant = participants.some((u) => u.id === viewer.userId);
    const canWrite =
      isOwner ||
      c.visibility === ConversationVisibility.COMPANY ||
      isParticipant;
    return {
      id: c.id,
      title: c.title,
      pinned: c.pinned,
      projectId: c.projectId,
      visibility: c.visibility,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      owner: c.user,
      participants,
      isOwner,
      canWrite,
    };
  }

  async update(
    companyId: string,
    userId: string,
    id: string,
    data: { title?: string; pinned?: boolean },
  ) {
    const conv = await this.getOwned(companyId, id);
    if (conv.userId !== userId) {
      throw new NotFoundException('Conversa não encontrada');
    }
    return this.prisma.conversation.update({ where: { id }, data });
  }

  async remove(companyId: string, userId: string, id: string) {
    const conv = await this.getOwned(companyId, id);
    if (conv.userId !== userId) {
      throw new NotFoundException('Conversa não encontrada');
    }
    await this.prisma.conversation.delete({ where: { id } });
    return { deleted: true };
  }

  async getMessages(companyId: string, viewer: Viewer, conversationId: string) {
    await this.getReadable(companyId, viewer, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      include: {
        agent: { select: { id: true, name: true, avatarSeed: true } },
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Busca a conversa do tenant sem checar dono/visibilidade (uso interno). */
  async getOwned(companyId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, companyId },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    return conv;
  }

  /** Resolve o acesso do viewer à conversa, aplicando as regras de visibilidade. */
  private async resolveAccess(companyId: string, viewer: Viewer, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, companyId },
      include: { participants: { select: { userId: true } } },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    const isOwner = conv.userId === viewer.userId;
    const isAdmin =
      viewer.role === UserRole.OWNER || viewer.role === UserRole.ADMIN;
    const isParticipant = conv.participants.some(
      (p) => p.userId === viewer.userId,
    );
    const isCompany = conv.visibility === ConversationVisibility.COMPANY;
    const canRead = isOwner || isAdmin || isCompany || isParticipant;
    if (!canRead) throw new NotFoundException('Conversa não encontrada');
    // Admin tem apenas leitura (supervisão): só escreve se for dono,
    // da empresa (COMPANY) ou participante explícito.
    const canWrite = isOwner || isCompany || isParticipant;
    return { conv, isOwner, canWrite };
  }

  /** Carrega a conversa exigindo acesso de LEITURA. */
  async getReadable(companyId: string, viewer: Viewer, id: string) {
    const { conv } = await this.resolveAccess(companyId, viewer, id);
    return conv;
  }

  /** Carrega a conversa exigindo acesso de ESCRITA. */
  async getWritable(companyId: string, viewer: Viewer, id: string) {
    const { conv, canWrite } = await this.resolveAccess(companyId, viewer, id);
    if (!canWrite) {
      throw new ForbiddenException(
        'Você tem acesso somente de leitura a esta conversa. Peça o compartilhamento ao dono.',
      );
    }
    return conv;
  }

  /* ---------- Compartilhamento ---------- */

  /** Estado de compartilhamento (dono, visibilidade e participantes). */
  async getShareState(companyId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, companyId },
      include: {
        user: { select: { id: true, name: true } },
        participants: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    return {
      id: conv.id,
      visibility: conv.visibility,
      owner: conv.user,
      participants: conv.participants.map((p) => p.user),
    };
  }

  /** Define a visibilidade da conversa e sincroniza participantes (só o dono). */
  async share(
    companyId: string,
    ownerUserId: string,
    id: string,
    data: { visibility: ConversationVisibility; userIds?: string[] },
  ) {
    const conv = await this.getOwned(companyId, id);
    if (conv.userId !== ownerUserId) {
      throw new NotFoundException('Conversa não encontrada');
    }

    let userIds: string[] = [];
    if (data.visibility === ConversationVisibility.USERS) {
      const requested = [...new Set(data.userIds ?? [])].filter(
        (uid) => uid !== ownerUserId,
      );
      if (requested.length) {
        const valid = await this.prisma.user.findMany({
          where: {
            id: { in: requested },
            memberships: { some: { companyId } },
          },
          select: { id: true },
        });
        userIds = valid.map((u) => u.id);
      }
    }

    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id },
        data: { visibility: data.visibility },
      }),
      // remove participantes que não estão mais na lista (todos, se não for USERS)
      this.prisma.conversationParticipant.deleteMany({
        where: {
          conversationId: id,
          ...(userIds.length ? { userId: { notIn: userIds } } : {}),
        },
      }),
      ...userIds.map((userId) =>
        this.prisma.conversationParticipant.upsert({
          where: { conversationId_userId: { conversationId: id, userId } },
          create: { conversationId: id, userId },
          update: {},
        }),
      ),
    ]);

    return this.getShareState(companyId, id);
  }

  /** Um usuário pede acesso a uma conversa que ainda não pode ver. */
  async requestShare(companyId: string, requester: Viewer, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, companyId },
      include: { participants: { select: { userId: true } } },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    if (conv.userId === requester.userId) {
      throw new BadRequestException('Você é o dono desta conversa.');
    }
    const alreadyHasAccess =
      conv.visibility === ConversationVisibility.COMPANY ||
      conv.participants.some((p) => p.userId === requester.userId);
    if (alreadyHasAccess) {
      throw new BadRequestException('Você já tem acesso a esta conversa.');
    }
    await this.prisma.conversationShareRequest.upsert({
      where: {
        conversationId_requesterId: {
          conversationId: id,
          requesterId: requester.userId,
        },
      },
      create: { conversationId: id, requesterId: requester.userId },
      update: { status: ShareRequestStatus.PENDING },
    });
    return { requested: true };
  }

  /** Solicitações pendentes nas conversas do dono. */
  async listShareRequests(companyId: string, ownerUserId: string) {
    return this.prisma.conversationShareRequest.findMany({
      where: {
        status: ShareRequestStatus.PENDING,
        conversation: { companyId, userId: ownerUserId },
      },
      include: {
        requester: { select: { id: true, name: true } },
        conversation: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Dono aprova (vira participante) ou nega uma solicitação. */
  async resolveShareRequest(
    companyId: string,
    ownerUserId: string,
    requestId: string,
    action: 'approve' | 'deny',
  ) {
    const req = await this.prisma.conversationShareRequest.findFirst({
      where: {
        id: requestId,
        conversation: { companyId, userId: ownerUserId },
      },
      include: { conversation: { select: { id: true, visibility: true } } },
    });
    if (!req) throw new NotFoundException('Solicitação não encontrada');

    if (action === 'deny') {
      await this.prisma.conversationShareRequest.update({
        where: { id: requestId },
        data: { status: ShareRequestStatus.DENIED },
      });
      return { ok: true };
    }

    await this.prisma.$transaction([
      this.prisma.conversationParticipant.upsert({
        where: {
          conversationId_userId: {
            conversationId: req.conversationId,
            userId: req.requesterId,
          },
        },
        create: { conversationId: req.conversationId, userId: req.requesterId },
        update: {},
      }),
      // conversa privada passa a USERS para o compartilhamento valer
      ...(req.conversation.visibility === ConversationVisibility.PRIVATE
        ? [
            this.prisma.conversation.update({
              where: { id: req.conversationId },
              data: { visibility: ConversationVisibility.USERS },
            }),
          ]
        : []),
      this.prisma.conversationShareRequest.update({
        where: { id: requestId },
        data: { status: ShareRequestStatus.APPROVED },
      }),
    ]);
    return { ok: true };
  }

  async uploadFile(
    companyId: string,
    viewer: Viewer,
    conversationId: string,
    file: { originalname: string; buffer: Buffer; mimetype: string },
  ) {
    const conv = await this.getWritable(companyId, viewer, conversationId);

    const safeName = `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`;
    const objectName = `${companyId}/${conversationId}/${safeName}`;
    await this.storage.upload(objectName, file.buffer, file.mimetype);

    // Also write to the filesystem shared with the Hermes bridge
    const localDir = join(
      this.sharedDataDir,
      'tenants',
      companyId,
      'workspace',
      'uploads',
    );
    await mkdir(localDir, { recursive: true });
    const localPath = join(localDir, safeName);
    await writeFile(localPath, file.buffer);

    // Track pending file paths on conversation metadata
    const meta =
      (conv.metadata as { pendingFilePaths?: string[] } | null) ?? {};
    const pending = [...(meta.pendingFilePaths ?? []), localPath];
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: {
          ...meta,
          pendingFilePaths: pending,
        },
      },
    });

    await this.prisma.message.create({
      data: {
        conversationId,
        sender: MessageSender.USER,
        userId: viewer.userId,
        type: MessageType.FILE,
        content: file.originalname,
        metadata: { objectName, localPath },
      },
    });

    return { objectName, localPath, fileName: file.originalname };
  }

  async sendMessage(
    companyId: string,
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
    role: UserRole = UserRole.MEMBER,
  ) {
    // Canais chamam passando o dono da conversa (userId === conv.userId), então
    // a checagem de escrita passa naturalmente; via HTTP vem o papel real.
    const conv = await this.getWritable(
      companyId,
      { userId, role },
      conversationId,
    );

    const agent = dto.agentId
      ? await this.prisma.agent.findFirst({
          where: { id: dto.agentId, companyId, isActive: true },
        })
      : // sem agente escolhido: o Gerente, ou o 1º liberado (convite restrito)
        await pickDefaultAgent(this.prisma, userId, companyId);
    if (!agent) {
      throw new NotFoundException(
        'Agente não encontrado (nem Agente Gerente disponível)',
      );
    }

    // RBAC: membro só aciona os agentes que o convite/admin liberou
    if (!(await canUseAgent(this.prisma, userId, companyId, agent.id))) {
      throw new ForbiddenException(
        'Você não tem acesso a este agente. Peça a liberação a um administrador.',
      );
    }
    // papel na org da conversa (ferramentas de admin abaixo)
    const requester = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true },
    });

    const providerChain = await this.resolveProviderChain(
      companyId,
      agent.capabilities,
    );
    // padrão da empresa (config do processo Hermes); sem ele, o bridge usa o
    // do agente — comportamento antigo
    const tenantProvider = await this.resolveProvider(companyId, {}).catch(
      () => undefined,
    );

    // "Tentar de novo": a mensagem do usuário já está gravada
    const userMessage = dto.retry
      ? null
      : await this.prisma.message.create({
          data: {
            conversationId,
            sender: MessageSender.USER,
            userId,
            type: MessageType.TEXT,
            content: dto.content,
          },
        });

    // Consume pending file paths
    const meta =
      (conv.metadata as { pendingFilePaths?: string[] } | null) ?? {};
    const filePaths = meta.pendingFilePaths ?? [];
    if (filePaths.length) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          metadata: { ...meta, pendingFilePaths: [] },
        },
      });
    }

    const agentTools = await this.tools.getBridgeToolsForAgent(agent.id);
    if (await this.knowledge.hasReadyDocuments(companyId)) {
      agentTools.push(this.knowledgeTool(companyId, agent.id));
    }
    agentTools.push(this.companyInfoTool(companyId));
    if (this.connectorRegistry.isOnline(companyId)) {
      agentTools.push(...this.localFilesTools(companyId));
    }
    agentTools.push(...this.taskTools(companyId, conv.projectId ?? undefined));
    const datasetCount = await this.prisma.dataset.count({
      where: { companyId },
    });
    if (datasetCount > 0) {
      agentTools.push(...this.datasetTools(companyId, conversationId));
    }
    const channelCount = await this.prisma.channel.count({
      where: { companyId },
    });
    if (channelCount > 0) {
      agentTools.push(this.channelMessagesTool(companyId));
    }
    if (conv.projectId) {
      agentTools.push(this.projectInfoTool(companyId, conv.projectId));
    }
    agentTools.push(this.platformGuideTool());
    // Sempre disponíveis: gráfico a partir da própria análise (sem base) e
    // relatório em PDF entregue na conversa.
    agentTools.push(this.chartRenderTool(companyId, conversationId));
    agentTools.push(this.reportPdfTool(companyId, conversationId));
    if (requester && requester.role !== 'MEMBER') {
      agentTools.push(...this.adminTools(companyId, userId));
    }
    let systemPrompt = agent.systemPrompt;
    if (agent.isManager) {
      const team = await this.prisma.agent.findMany({
        where: { companyId, isActive: true, isManager: false },
        select: { name: true, role: true },
        orderBy: { createdAt: 'asc' },
      });
      if (team.length) {
        agentTools.push(
          this.specialistTool(companyId, conversationId, userId, team),
        );
        systemPrompt += `\n\n${ConversationsService.managerBrief(team)}`;
      }
    }
    const sandbox = this.resolveSandbox();

    const request: BridgeChatRequest = {
      tenant_id: companyId,
      // Sessão ACP por AGENTE dentro da conversa: sem isto, todos os agentes
      // compartilham o mesmo contexto no Hermes e um agente mencionado "herda"
      // a persona de quem falou antes (ex.: responde como o Gerente). Cada
      // agente mantém sua própria continuidade na conversa.
      session_id: `${conversationId}:${agent.id}`,
      message: dto.content,
      file_paths: filePaths,
      tools: agentTools,
      sandbox,
      agent: {
        agent_id: agent.id,
        name: agent.name,
        system_prompt: systemPrompt,
      },
      provider: providerChain[0],
      tenant_provider: tenantProvider,
    };

    // Fire-and-forget: the stream feeds SSE subscribers and persistence
    this.stream.begin(conversationId);
    this.turns.set(conversationId, { startedAt: Date.now(), team: [] });
    void this.consumeBridge(
      conversationId,
      agent.id,
      request,
      userId,
      providerChain,
    );

    return { userMessage, agentId: agent.id };
  }

  private async consumeBridge(
    conversationId: string,
    agentId: string,
    request: BridgeChatRequest,
    requesterUserId?: string,
    providerChain?: BridgeChatRequest['provider'][],
  ) {
    try {
      await this.consumeProviderChain(
        conversationId,
        agentId,
        request,
        requesterUserId,
        providerChain,
      );
    } finally {
      this.turns.delete(conversationId);
      this.stream.end(conversationId);
    }
  }

  /** Erro do turno: texto amigável na tela, detalhe cru no evento/auditoria. */
  private emitTurnError(
    conversationId: string,
    companyId: string,
    agentId: string,
    raw: string | undefined,
  ) {
    this.stream.emit(conversationId, {
      type: 'error',
      agent_id: agentId,
      text: friendlyChatError(raw),
      data: { detail: (raw ?? '').slice(0, 500) },
    });
    void this.prisma.orchestrationEvent
      .create({
        data: {
          companyId,
          conversationId,
          agentId,
          type: 'error',
          payload: { text: raw ?? '' },
        },
      })
      .catch(() => undefined);
  }

  private async consumeProviderChain(
    conversationId: string,
    agentId: string,
    request: BridgeChatRequest,
    requesterUserId?: string,
    providerChain?: BridgeChatRequest['provider'][],
  ) {
    // provedor que caiu há pouco vai para o fim: a mensagem não espera ele
    // falhar de novo antes de chegar na reserva
    const chain = this.healthyFirst(
      request.tenant_id,
      providerChain?.length ? providerChain : [request.provider],
    );
    for (let attempt = 0; attempt < chain.length; attempt++) {
      const provider = chain[attempt];
      const isLast = attempt === chain.length - 1;
      const failed = await this.consumeBridgeOnce(
        conversationId,
        agentId,
        { ...request, provider },
        requesterUserId,
        !isLast,
      );
      if (!failed) return;
      const next = chain[attempt + 1];
      if (next) {
        this.logger.warn(
          `provider ${provider.provider} falhou — fallback para ${next.provider} (conversa ${conversationId})`,
        );
        await this.prisma.orchestrationEvent
          .create({
            data: {
              companyId: request.tenant_id,
              conversationId,
              agentId,
              type: 'provider_fallback',
              payload: {
                de: provider.provider,
                para: next.provider,
                modelo: next.model,
              },
            },
          })
          .catch(() => undefined);
        // restart: a web descarta o texto parcial do provedor que caiu
        this.stream.emit(conversationId, {
          type: 'agent_status',
          agent_id: agentId,
          text: `Provedor ${provider.provider} indisponível, usando a reserva (${next.provider})`,
          data: { restart: true },
        });
      }
    }
  }

  /** Uma tentativa; retorna true se falhou por PROVEDOR e pode haver retry. */
  private async consumeBridgeOnce(
    conversationId: string,
    agentId: string,
    request: BridgeChatRequest,
    requesterUserId: string | undefined,
    retryAvailable: boolean,
  ): Promise<boolean> {
    const healthKey = providerHealthKey(
      request.tenant_id,
      request.provider.provider,
      request.provider.api_key,
    );
    const providerFailed = () => {
      markProviderDown(healthKey);
      return retryAvailable;
    };
    // o turno precisa acabar em resposta ou em erro; nunca em silêncio
    let settled = false;
    try {
      for await (const event of this.bridge.chat(request)) {
        if (event.type === 'error') {
          if (isProviderError(event.text) && providerFailed()) return true;
          settled = true;
          this.emitTurnError(
            conversationId,
            request.tenant_id,
            event.agent_id ?? agentId,
            event.text,
          );
          continue;
        }
        // Emite no SSE antes de qualquer I/O: um INSERT por token serializava
        // o streaming atrás do banco. Chunks são transientes e não são persistidos
        // (a resposta completa vira Message em final_message).
        // Exceção: final_message só depois de gravar — a web recarrega as
        // mensagens ao recebê-lo e, sob carga, a resposta sumia da tela; e uma
        // falha de provedor com reserva não deve encerrar o stream da web.
        if (event.type !== 'final_message') {
          this.stream.emit(conversationId, event);
        }
        if (event.type !== 'token_chunk' && event.type !== 'thought_chunk') {
          this.prisma.orchestrationEvent
            .create({
              data: {
                companyId: request.tenant_id,
                conversationId,
                agentId: event.agent_id ?? agentId,
                type: event.type,
                payload: (event as unknown as Prisma.InputJsonValue) ?? {},
              },
            })
            .catch(() => undefined);
        }

        if (event.type === 'usage' && event.data) {
          const usage = event.data as {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            model?: string;
          };
          this.prisma.tokenUsage
            .create({
              data: {
                companyId: request.tenant_id,
                conversationId,
                agentId: event.agent_id ?? agentId,
                userId: requesterUserId,
                model: usage.model ?? '',
                promptTokens: usage.promptTokens ?? 0,
                completionTokens: usage.completionTokens ?? 0,
                totalTokens: usage.totalTokens ?? 0,
              },
            })
            .catch(() => undefined);
        }

        if (event.type === 'final_message' && event.text) {
          // o Hermes devolve a falha do provedor como texto ("API call failed…")
          if (isProviderFailureText(event.text) && providerFailed()) {
            return true; // não persiste a falha — a reserva assume
          }
          markProviderUp(healthKey);
          const charts = await this.chartService
            .drainPending(conversationId)
            .catch(() => []);
          const reports = await this.reportService
            .drainPending(conversationId)
            .catch(() => []);
          const metadata: Record<string, unknown> = {};
          if (charts.length) metadata.charts = charts;
          if (reports.length) metadata.reports = reports;
          const turn = this.turns.get(conversationId);
          if (turn?.team.length) {
            metadata.team = turn.team.map(({ agentId, name, role, task }) => ({
              agentId,
              name,
              role,
              task,
            }));
            metadata.durationMs = Date.now() - turn.startedAt;
          }
          await this.prisma.message.create({
            data: {
              conversationId,
              sender: MessageSender.AGENT,
              agentId: event.agent_id ?? agentId,
              type: MessageType.TEXT,
              content: event.text,
              ...(Object.keys(metadata).length
                ? { metadata: metadata as Prisma.InputJsonValue }
                : {}),
            },
          });
          await this.prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
          });
          // gravada: a web já encontra a resposta ao recarregar
          settled = true;
          this.stream.emit(conversationId, event);
          // conversa vinda de canal (Telegram etc.): devolve pelo canal
          await this.channelDelivery
            .deliver(conversationId, event.text)
            .catch(() => undefined);
        } else if (event.type === 'final_message') {
          // resposta vazia: vira erro visível, com "tentar de novo"
          settled = true;
          this.emitTurnError(
            conversationId,
            request.tenant_id,
            agentId,
            'O agente terminou o turno sem resposta.',
          );
        }
      }
      if (!settled) {
        this.emitTurnError(
          conversationId,
          request.tenant_id,
          agentId,
          'O stream do agente terminou antes da resposta.',
        );
      }
      return false;
    } catch (err) {
      const message = (err as Error).message;
      if (isProviderError(message) && providerFailed()) return true;
      this.logger.error(`Erro no stream do bridge: ${message}`);
      this.emitTurnError(conversationId, request.tenant_id, agentId, message);
      return false;
    }
  }

  /** Instruções do Gerente por turno: a equipe real e como acioná-la. */
  static managerBrief(team: { name: string; role: string | null }[]) {
    const roster = team
      .map((a) => `- ${a.name}${a.role ? ` — ${a.role}` : ''}`)
      .join('\n');
    return `Equipe de especialistas disponível:
${roster}

Como trabalhar com a equipe:
- Saudações, dúvidas gerais e perguntas simples: responda você mesmo, em poucas frases, sem acionar ninguém e sem listar a equipe.
- Quando a demanda exigir o conhecimento de um setor, acione o especialista certo com a ferramenta especialista_acionar, passando uma tarefa clara e completa. Pode acionar mais de um quando a demanda envolver vários setores.
- Depois, consolide o que os especialistas entregaram numa resposta única, objetiva e profissional, citando quem contribuiu.`;
  }

  /** Ferramenta do Gerente: aciona um especialista real e espera o resultado. */
  private specialistTool(
    companyId: string,
    conversationId: string,
    requesterId: string,
    team: { name: string; role: string | null }[],
  ) {
    const url = new URL(
      `${this.internalApiUrl}/internal/conversations/especialista`,
    );
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('conversationId', conversationId);
    url.searchParams.set('requesterId', requesterId);
    return {
      name: 'especialista_acionar',
      description: `Aciona um especialista da equipe para executar uma tarefa e devolve o resultado do trabalho dele. Especialistas: ${team
        .map((a) => `${a.name}${a.role ? ` (${a.role})` : ''}`)
        .join(', ')}.`,
      method: 'POST',
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: {
        type: 'object',
        properties: {
          especialista: {
            type: 'string',
            description: 'Nome do especialista (ex.: Camila)',
          },
          tarefa: {
            type: 'string',
            description:
              'O que ele deve fazer, com todo o contexto necessário da conversa',
          },
        },
        required: ['especialista', 'tarefa'],
      },
      // o especialista roda um turno inteiro do modelo
      timeout_ms: 170_000,
    };
  }

  /**
   * Executa o turno de um especialista a pedido do Gerente: a web vê o
   * especialista entrar e terminar (eventos agent_delegation), e o texto dele
   * volta como resultado da ferramenta — sem tokens no balão do Gerente.
   */
  async runSpecialist(
    companyId: string,
    conversationId: string,
    requesterId: string,
    nome: string | undefined,
    tarefa: string | undefined,
  ): Promise<{ especialista?: string; resposta?: string; erro?: string }> {
    const team = await this.prisma.agent.findMany({
      where: { companyId, isActive: true, isManager: false },
      orderBy: { createdAt: 'asc' },
    });
    const wanted = (nome ?? '').trim().toLowerCase();
    const agent =
      team.find((a) => a.name.toLowerCase() === wanted) ??
      team.find(
        (a) =>
          wanted &&
          (a.name.toLowerCase().includes(wanted) ||
            wanted.includes(a.name.toLowerCase().split(' ')[0])),
      );
    if (!agent) {
      return {
        erro: `Especialista não encontrado. Equipe: ${team.map((a) => a.name).join(', ')}.`,
      };
    }
    if (!tarefa?.trim()) return { erro: 'Informe a tarefa do especialista.' };
    if (!(await canUseAgent(this.prisma, requesterId, companyId, agent.id))) {
      return {
        erro: `A pessoa desta conversa não tem acesso a ${agent.name}. Responda sem acioná-lo.`,
      };
    }

    const member: TeamMember = {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      task: tarefa.trim().slice(0, 160),
      status: 'working',
    };
    const turn = this.turns.get(conversationId);
    turn?.team.push(member);
    const announce = () =>
      this.stream.emit(conversationId, {
        type: 'agent_delegation',
        agent_id: agent.id,
        text: member.task,
        data: { status: member.status, name: agent.name, role: agent.role },
      });
    announce();

    try {
      const chain = this.healthyFirst(
        companyId,
        await this.resolveProviderChain(companyId, agent.capabilities),
      );
      const tenantProvider = await this.resolveProvider(companyId, {}).catch(
        () => undefined,
      );
      const tools = await this.tools.getBridgeToolsForAgent(agent.id);
      if (await this.knowledge.hasReadyDocuments(companyId)) {
        tools.push(this.knowledgeTool(companyId, agent.id));
      }
      tools.push(this.companyInfoTool(companyId));

      let answer = '';
      let failure: string | undefined;
      // mesma cadeia do chat: provedor caído passa para a reserva
      for (const [i, provider] of chain.entries()) {
        answer = '';
        failure = undefined;
        const healthKey = providerHealthKey(
          companyId,
          provider.provider,
          provider.api_key,
        );
        try {
          for await (const ev of this.bridge.chat({
            tenant_id: companyId,
            session_id: `${conversationId}:${agent.id}`,
            message: `Tarefa recebida do Agente Gerente:\n${tarefa.trim()}`,
            file_paths: [],
            tools,
            sandbox: this.resolveSandbox(),
            agent: {
              agent_id: agent.id,
              name: agent.name,
              system_prompt: agent.systemPrompt,
            },
            provider,
            tenant_provider: tenantProvider,
          })) {
            if (ev.type === 'final_message') answer = ev.text ?? '';
            else if (ev.type === 'error') failure = ev.text;
            else if (ev.type === 'usage' && ev.data) {
              this.recordUsage(
                companyId,
                conversationId,
                agent.id,
                requesterId,
                ev.data,
              );
            }
          }
        } catch (err) {
          failure = (err as Error).message;
        }
        const providerDown = answer
          ? isProviderFailureText(answer)
          : isProviderError(failure);
        if (!providerDown) {
          if (answer) markProviderUp(healthKey);
          break;
        }
        markProviderDown(healthKey);
        failure ??= answer;
        answer = '';
        if (i === chain.length - 1) break;
      }
      if (!answer) throw new Error(failure ?? 'sem resposta');
      member.status = 'done';
      announce();
      return { especialista: agent.name, resposta: answer };
    } catch (err) {
      member.status = 'error';
      announce();
      this.logger.warn(
        `especialista ${agent.name} falhou: ${(err as Error).message}`,
      );
      return {
        erro: `${agent.name} não conseguiu concluir agora (${friendlyChatError((err as Error).message)}). Responda com o que você sabe e avise a pessoa.`,
      };
    }
  }

  private recordUsage(
    companyId: string,
    conversationId: string,
    agentId: string,
    userId: string | undefined,
    data: Record<string, unknown>,
  ) {
    const u = data as {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      model?: string;
    };
    this.prisma.tokenUsage
      .create({
        data: {
          companyId,
          conversationId,
          agentId,
          userId,
          model: u.model ?? '',
          promptTokens: u.promptTokens ?? 0,
          completionTokens: u.completionTokens ?? 0,
          totalTokens: u.totalTokens ?? 0,
        },
      })
      .catch(() => undefined);
  }

  /** Ferramenta embutida de RAG: busca na base de conhecimento da empresa. */
  private knowledgeTool(companyId: string, agentId: string) {
    const url = new URL(`${this.internalApiUrl}/internal/knowledge/search`);
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('agentId', agentId);
    return {
      name: 'buscar_conhecimento',
      description:
        'Busca trechos relevantes na base de conhecimento da empresa (documentos internos, manuais, políticas). Use sempre que a pergunta puder ser respondida por documentos da empresa.',
      method: 'POST',
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Termos de busca em português (palavras-chave do assunto)',
          },
        },
        required: ['query'],
      },
      timeout_ms: 15000,
    };
  }

  /** Ferramenta embutida: retorna informações gerais da empresa, agentes e departamentos. */
  private companyInfoTool(companyId: string) {
    const url = new URL(`${this.internalApiUrl}/internal/company/info`);
    url.searchParams.set('companyId', companyId);
    return {
      name: 'obter_informacoes_empresa',
      description:
        'Retorna informações gerais sobre a empresa, lista de agentes ativos com seus cargos e descrições, departamentos e funcionários. Use sempre que o usuário perguntar quem são os agentes da empresa, quantos agentes existem, quais são os departamentos, quem trabalha em qual departamento, ou dados de contato e gerais sobre a própria empresa/funcionários.',
      method: 'GET',
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: {
        type: 'object',
        properties: {},
      },
      timeout_ms: 15000,
    };
  }

  /**
   * Gráfico a partir da própria análise do agente (sem base de dados). Os
   * pontos vêm calculados pelo modelo; o gráfico aparece inline na conversa.
   */
  private chartRenderTool(companyId: string, conversationId: string) {
    const url = new URL(
      `${this.internalApiUrl}/internal/datasets/grafico-livre`,
    );
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('conversationId', conversationId);
    return {
      name: 'grafico_render',
      description:
        'Exibe um GRÁFICO na conversa a partir de dados que VOCÊ fornece (você calcula os números na sua análise e passa os pontos aqui). Funciona para qualquer análise, mesmo SEM base de dados importada. Depois de chamar, apenas comente os insights — não descreva o gráfico. Para gráficos a partir de planilhas importadas, prefira grafico_gerar.',
      method: 'POST',
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: {
        type: 'object',
        properties: {
          tipo: {
            type: 'string',
            enum: ['linha', 'barra', 'area', 'pizza'],
            description:
              'linha/area p/ evolução no tempo, barra p/ comparações, pizza p/ composição',
          },
          titulo: { type: 'string', description: 'Título curto do gráfico' },
          eixo_x: {
            type: 'string',
            description: 'Rótulo do eixo X (ex.: Mês, Categoria)',
          },
          categorias: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Rótulos do eixo X, na ordem. Ex.: ["Jan","Fev","Mar"]',
          },
          series: {
            type: 'array',
            description:
              'Até 5 séries. Cada valores[] alinha 1-a-1 com categorias.',
            items: {
              type: 'object',
              properties: {
                nome: { type: 'string', description: 'Rótulo da série' },
                valores: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Um número por categoria, na mesma ordem',
                },
                tracejada: {
                  type: 'boolean',
                  description: 'Linha tracejada (ex.: projeção)',
                },
              },
              required: ['valores'],
            },
          },
        },
        required: ['categorias', 'series'],
      },
      timeout_ms: 15000,
    };
  }

  /**
   * Relatório em PDF entregue na conversa: o agente escreve o conteúdo em
   * Markdown e o usuário baixa o PDF (gerado no navegador dele). Nada é salvo
   * no computador do usuário até o clique em "Baixar PDF".
   */
  private reportPdfTool(companyId: string, conversationId: string) {
    const url = new URL(
      `${this.internalApiUrl}/internal/datasets/relatorio-pdf`,
    );
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('conversationId', conversationId);
    return {
      name: 'relatorio_pdf',
      description:
        'Monta um RELATÓRIO em PDF que aparece na conversa com um botão "Baixar PDF" para o usuário. Use SEMPRE que pedirem um relatório, documento ou PDF. Escreva o conteúdo em Markdown (use ## para títulos, listas com - e tabelas | col | col |). O PDF é gerado no navegador do usuário no clique — não salva nada no computador dele. Depois de chamar, não repita o conteúdo em texto: apenas confirme que o relatório está pronto para download.',
      method: 'POST',
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título do relatório' },
          conteudo_markdown: {
            type: 'string',
            description:
              'Corpo do relatório em Markdown (títulos ##, listas, tabelas).',
          },
        },
        required: ['titulo', 'conteudo_markdown'],
      },
      timeout_ms: 15000,
    };
  }

  /** Ferramenta embutida: guia passo a passo dos recursos da plataforma. */
  private platformGuideTool() {
    return {
      name: 'guia_plataforma',
      description:
        'Retorna o passo a passo oficial de como usar um recurso do Alpha Agents Office. Use SEMPRE que o usuário perguntar como fazer algo na plataforma (ex.: instalar o conector local, criar projetos/tarefas, alimentar a base de conhecimento, criar agentes, convidar usuários, criar ferramentas). Tópicos: conector, projetos, conhecimento, agentes, usuarios, ferramentas.',
      method: 'POST',
      url: `${this.internalApiUrl}/internal/admin/guia`,
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: {
        type: 'object',
        properties: {
          topico: {
            type: 'string',
            enum: [
              'conector',
              'projetos',
              'conhecimento',
              'agentes',
              'usuarios',
              'ferramentas',
            ],
            description: 'Recurso sobre o qual o usuário quer orientação',
          },
        },
        required: ['topico'],
      },
      timeout_ms: 15000,
    };
  }

  /**
   * Ferramentas administrativas — injetadas apenas quando o usuário da
   * conversa é OWNER/ADMIN (o endpoint revalida o papel pelo requesterId).
   */
  private adminTools(companyId: string, requesterId: string) {
    const op = (path: string) => {
      const url = new URL(`${this.internalApiUrl}/internal/admin/${path}`);
      url.searchParams.set('companyId', companyId);
      url.searchParams.set('requesterId', requesterId);
      return url.toString();
    };
    const base = {
      method: 'POST',
      headers: { 'x-bridge-key': this.bridgeApiKey },
      timeout_ms: 15000,
    };
    return [
      {
        ...base,
        name: 'agentes_criar',
        description:
          'Cria um novo agente de IA no escritório da empresa (nome, cargo, setor e instruções). Use quando o usuário pedir para contratar/criar um novo agente ou especialista. Confirme nome e função com o usuário antes de criar.',
        url: op('agentes/criar'),
        params_schema: {
          type: 'object',
          properties: {
            nome: {
              type: 'string',
              description: 'Nome próprio do agente (ex.: Carla)',
            },
            cargo: {
              type: 'string',
              description: 'Função (ex.: Analista de RH)',
            },
            descricao: {
              type: 'string',
              description: 'Resumo do que o agente faz',
            },
            setor: {
              type: 'string',
              description: 'Nome do setor existente (opcional)',
            },
            prompt: {
              type: 'string',
              description:
                'Instruções de comportamento do agente, em português',
            },
          },
          required: ['nome', 'cargo'],
        },
      },
      {
        ...base,
        name: 'usuarios_criar',
        description:
          'Cria o acesso de um novo usuário (funcionário) à plataforma, com papel MEMBRO ou ADMIN, e retorna a senha temporária que deve ser repassada a ele com segurança. Use quando o usuário pedir para criar um acesso/convidar alguém. Confirme nome, e-mail e papel antes.',
        url: op('usuarios/criar'),
        params_schema: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            email: { type: 'string' },
            papel: {
              type: 'string',
              enum: ['MEMBRO', 'ADMIN'],
              description: 'Padrão: MEMBRO',
            },
          },
          required: ['nome', 'email'],
        },
      },
    ];
  }

  /** Ferramenta embutida: contexto do projeto vinculado a esta conversa. */
  private projectInfoTool(companyId: string, projectId: string) {
    const url = new URL(`${this.internalApiUrl}/internal/projects/info`);
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('projectId', projectId);
    return {
      name: 'projeto_atual',
      description:
        'Retorna nome, descrição, status, requisitos levantados e setores do projeto ao qual esta conversa pertence. Use antes de responder perguntas sobre o projeto ou criar tarefas nele.',
      method: 'GET',
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      params_schema: { type: 'object', properties: {} },
      timeout_ms: 15000,
    };
  }

  /**
   * Ferramentas de gestão de tarefas (kanban). Com projectId, operam nas
   * tarefas do projeto desta conversa; sem, nas tarefas avulsas da empresa.
   * Não há ferramenta de exclusão: agentes nunca excluem nada.
   */
  /** Ferramentas de dados estruturados (datasets): só leitura e agregação. */
  private datasetTools(companyId: string, conversationId: string) {
    const op = (path: string, method: 'GET' | 'POST' = 'POST') => {
      const url = new URL(`${this.internalApiUrl}/internal/datasets/${path}`);
      url.searchParams.set('companyId', companyId);
      url.searchParams.set('conversationId', conversationId);
      return { url: url.toString(), method };
    };
    const base = {
      headers: { 'x-bridge-key': this.bridgeApiKey },
      timeout_ms: 20000,
    };
    return [
      {
        ...base,
        ...op('listar', 'GET'),
        name: 'dados_listar',
        description:
          'Lista as bases de dados estruturados da empresa (planilhas importadas): nome, colunas com tipos e descrições, quantidade de linhas e qualidade. SEMPRE chame antes de consultar dados.',
        params_schema: { type: 'object', properties: {} },
      },
      {
        ...base,
        ...op('amostra'),
        name: 'dados_amostra',
        description:
          'Retorna as primeiras linhas de uma base de dados para você entender a estrutura e os valores reais antes de montar consultas.',
        params_schema: {
          type: 'object',
          properties: {
            base: { type: 'string', description: 'Nome da base de dados' },
            linhas: {
              type: 'number',
              description: 'Quantidade de linhas (padrão 5, máx 20)',
            },
          },
          required: ['base'],
        },
      },
      {
        ...base,
        ...op('consultar'),
        name: 'dados_consultar',
        description:
          'Consulta uma base de dados com filtros, agrupamento e agregações calculados pelo servidor (nunca calcule você mesmo somas ou médias sobre muitas linhas — use esta ferramenta e cite os números retornados). Ex.: total por categoria: {"base":"Orçamento 2026","agrupar_por":["categoria"],"agregacoes":[{"funcao":"soma","coluna":"valor"}]}.',
        params_schema: {
          type: 'object',
          properties: {
            base: { type: 'string', description: 'Nome da base de dados' },
            filtros: {
              type: 'array',
              description: 'Filtros combinados com E lógico',
              items: {
                type: 'object',
                properties: {
                  coluna: { type: 'string' },
                  operador: {
                    type: 'string',
                    enum: ['=', '!=', '>', '>=', '<', '<=', 'contem'],
                  },
                  valor: { type: 'string' },
                },
                required: ['coluna', 'operador', 'valor'],
              },
            },
            agrupar_por: {
              type: 'array',
              items: { type: 'string' },
              description: 'Colunas de agrupamento',
            },
            agregacoes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  funcao: {
                    type: 'string',
                    enum: ['soma', 'media', 'min', 'max', 'contagem'],
                  },
                  coluna: { type: 'string' },
                },
                required: ['funcao'],
              },
            },
            ordenar_por: {
              type: 'string',
              description:
                'Coluna de grupo ou alias de agregação (ex.: soma_valor)',
            },
            ordem: { type: 'string', enum: ['asc', 'desc'] },
            limite: {
              type: 'number',
              description:
                'Máximo de linhas no resultado (padrão 100, máx 500)',
            },
          },
          required: ['base'],
        },
      },
      {
        ...base,
        ...op('comparar'),
        name: 'dados_comparar',
        description:
          'Compara dois recortes da base por uma dimensão (ex.: realizado × orçado por setor; mês atual × anterior) com deltas em valor E percentual calculados pelo servidor, ordenados pelos maiores desvios. O gráfico comparativo aparece junto com a resposta.',
        params_schema: {
          type: 'object',
          properties: {
            base: { type: 'string' },
            dimensao: {
              type: 'string',
              description: 'Coluna de agrupamento (setor, mes, produto…)',
            },
            valor_a: {
              type: 'object',
              description: 'Lado A (ex.: realizado)',
              properties: {
                coluna: { type: 'string' },
                funcao: {
                  type: 'string',
                  enum: ['soma', 'media', 'min', 'max', 'contagem'],
                },
                nome: { type: 'string' },
                filtros: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      coluna: { type: 'string' },
                      operador: {
                        type: 'string',
                        enum: ['=', '!=', '>', '>=', '<', '<=', 'contem'],
                      },
                      valor: { type: 'string' },
                    },
                    required: ['coluna', 'operador', 'valor'],
                  },
                },
              },
              required: ['coluna'],
            },
            valor_b: {
              type: 'object',
              description: 'Lado B, a referência (ex.: orçado)',
              properties: {
                coluna: { type: 'string' },
                funcao: {
                  type: 'string',
                  enum: ['soma', 'media', 'min', 'max', 'contagem'],
                },
                nome: { type: 'string' },
                filtros: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      coluna: { type: 'string' },
                      operador: {
                        type: 'string',
                        enum: ['=', '!=', '>', '>=', '<', '<=', 'contem'],
                      },
                      valor: { type: 'string' },
                    },
                    required: ['coluna', 'operador', 'valor'],
                  },
                },
              },
              required: ['coluna'],
            },
            filtros: {
              type: 'array',
              description: 'Filtros comuns aos dois lados',
              items: {
                type: 'object',
                properties: {
                  coluna: { type: 'string' },
                  operador: {
                    type: 'string',
                    enum: ['=', '!=', '>', '>=', '<', '<=', 'contem'],
                  },
                  valor: { type: 'string' },
                },
                required: ['coluna', 'operador', 'valor'],
              },
            },
            titulo: { type: 'string' },
          },
          required: ['base', 'dimensao', 'valor_a', 'valor_b'],
        },
      },
      {
        ...base,
        ...op('prever'),
        name: 'dados_prever',
        description:
          'Projeta valores FUTUROS de uma série temporal da base de dados com métodos estatísticos calculados pelo servidor (média móvel, regressão, sazonal — escolhidos por backtest), com faixa de confiança. O gráfico da projeção aparece junto com a sua resposta. Sempre apresente como estimativa em faixa, nunca como certeza.',
        params_schema: {
          type: 'object',
          properties: {
            base: { type: 'string', description: 'Nome da base de dados' },
            coluna_data: {
              type: 'string',
              description: 'Coluna de data da série',
            },
            coluna_valor: {
              type: 'string',
              description: 'Coluna numérica a prever',
            },
            funcao: {
              type: 'string',
              enum: ['soma', 'media'],
              description: 'Agregação por período (padrão soma)',
            },
            granularidade: {
              type: 'string',
              enum: ['dia', 'mes'],
              description: 'Período da série (padrão mes)',
            },
            horizonte: {
              type: 'number',
              description: 'Quantos períodos prever (padrão 6, máx 24)',
            },
            filtros: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  coluna: { type: 'string' },
                  operador: {
                    type: 'string',
                    enum: ['=', '!=', '>', '>=', '<', '<=', 'contem'],
                  },
                  valor: { type: 'string' },
                },
                required: ['coluna', 'operador', 'valor'],
              },
            },
            titulo: { type: 'string' },
          },
          required: ['base', 'coluna_data', 'coluna_valor'],
        },
      },
      {
        ...base,
        ...op('grafico'),
        name: 'grafico_gerar',
        description:
          'Gera um GRÁFICO INTERATIVO que aparece automaticamente junto com a sua resposta no chat. O servidor calcula os pontos a partir da base de dados — use para tendências, comparações e composições. Depois de chamar, apenas comente os insights (não descreva o gráfico).',
        params_schema: {
          type: 'object',
          properties: {
            base: { type: 'string', description: 'Nome da base de dados' },
            tipo: {
              type: 'string',
              enum: ['linha', 'barra', 'area', 'pizza'],
              description:
                'linha/area p/ séries temporais, barra p/ comparações, pizza p/ composição',
            },
            titulo: { type: 'string', description: 'Título curto do gráfico' },
            eixo_x: {
              type: 'string',
              description: 'Coluna do eixo X (categoria ou data)',
            },
            series: {
              type: 'array',
              description: 'Até 5 séries numéricas',
              items: {
                type: 'object',
                properties: {
                  coluna: { type: 'string' },
                  funcao: {
                    type: 'string',
                    enum: ['soma', 'media', 'min', 'max', 'contagem'],
                  },
                  nome: {
                    type: 'string',
                    description: 'Rótulo da série (opcional)',
                  },
                },
                required: ['coluna'],
              },
            },
            filtros: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  coluna: { type: 'string' },
                  operador: {
                    type: 'string',
                    enum: ['=', '!=', '>', '>=', '<', '<=', 'contem'],
                  },
                  valor: { type: 'string' },
                },
                required: ['coluna', 'operador', 'valor'],
              },
            },
          },
          required: ['base', 'eixo_x', 'series'],
        },
      },
    ];
  }

  /** Consulta do histórico de canais (WhatsApp/Telegram/e-mail) — só leitura. */
  private channelMessagesTool(companyId: string) {
    const url = new URL(`${this.internalApiUrl}/internal/channels/mensagens`);
    url.searchParams.set('companyId', companyId);
    return {
      name: 'canais_mensagens',
      description:
        'Lista mensagens dos canais externos da empresa (WhatsApp, Telegram, e-mail) — recebidas de clientes e enviadas. Use para relatórios e análises como "últimas 50 mensagens do WhatsApp" ou "assuntos dos últimos e-mails".',
      method: 'POST' as const,
      url: url.toString(),
      headers: { 'x-bridge-key': this.bridgeApiKey },
      timeout_ms: 15000,
      params_schema: {
        type: 'object',
        properties: {
          canal: {
            type: 'string',
            enum: ['whatsapp', 'telegram', 'email'],
            description: 'Filtrar por tipo de canal (opcional)',
          },
          contato: {
            type: 'string',
            description:
              'Filtrar por nome/telefone/e-mail do contato (opcional)',
          },
          direcao: {
            type: 'string',
            enum: ['IN', 'OUT'],
            description: 'IN = recebidas, OUT = enviadas (opcional)',
          },
          limite: {
            type: 'number',
            description: 'Quantidade (padrão 50, máx 200)',
          },
        },
      },
    };
  }

  private taskTools(companyId: string, projectId?: string) {
    const op = (path: string) => {
      const url = new URL(
        `${this.internalApiUrl}/internal/projects/tarefas/${path}`,
      );
      url.searchParams.set('companyId', companyId);
      if (projectId) url.searchParams.set('projectId', projectId);
      return url.toString();
    };
    const base = {
      method: 'POST',
      headers: { 'x-bridge-key': this.bridgeApiKey },
      timeout_ms: 15000,
    };
    const escopo = projectId
      ? 'do projeto desta conversa'
      : 'avulsas da empresa (sem projeto)';
    const statusEnum = ['A_FAZER', 'EM_ANDAMENTO', 'EM_REVISAO', 'CONCLUIDA'];
    return [
      {
        ...base,
        name: 'tarefas_listar',
        description: `Lista as tarefas ${escopo} do quadro kanban, com status, prioridade, prazo e responsáveis (agentes e usuários). Use para saber o que está em andamento e quem está trabalhando em quê.`,
        url: op('listar'),
        params_schema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: statusEnum,
              description: 'Filtrar por status (opcional)',
            },
            lista: {
              type: 'string',
              description: 'Filtrar por nome da lista (opcional)',
            },
          },
        },
      },
      {
        ...base,
        name: 'tarefas_criar',
        description: `Cria uma tarefa ${escopo} no quadro kanban (status inicial A_FAZER). Pode indicar lista e responsáveis pelo nome (agentes ou usuários da empresa).`,
        url: op('criar'),
        params_schema: {
          type: 'object',
          properties: {
            titulo: { type: 'string', description: 'Título curto da tarefa' },
            descricao: {
              type: 'string',
              description: 'Detalhes do que precisa ser feito',
            },
            prioridade: {
              type: 'string',
              enum: ['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'],
            },
            lista: {
              type: 'string',
              description: 'Nome da lista (criada se não existir)',
            },
            responsaveis: {
              type: 'array',
              items: { type: 'string' },
              description: 'Nomes de agentes ou usuários responsáveis',
            },
          },
          required: ['titulo'],
        },
      },
      {
        ...base,
        name: 'tarefas_atualizar_status',
        description: `Muda o status de uma tarefa ${escopo} no kanban (ex.: mover para EM_ANDAMENTO quando começar, CONCLUIDA quando terminar). Identifique por tarefa_id ou título.`,
        url: op('atualizar-status'),
        params_schema: {
          type: 'object',
          properties: {
            tarefa_id: {
              type: 'string',
              description: 'Id da tarefa (preferido)',
            },
            titulo: {
              type: 'string',
              description: 'Título da tarefa (alternativa ao id)',
            },
            status: { type: 'string', enum: statusEnum },
          },
          required: ['status'],
        },
      },
      {
        ...base,
        name: 'tarefas_atribuir',
        description: `Adiciona um responsável (agente ou usuário, pelo nome) a uma tarefa ${escopo}. Identifique a tarefa por tarefa_id ou título.`,
        url: op('atribuir'),
        params_schema: {
          type: 'object',
          properties: {
            tarefa_id: { type: 'string' },
            titulo: { type: 'string' },
            nome: { type: 'string', description: 'Nome do agente ou usuário' },
          },
          required: ['nome'],
        },
      },
    ];
  }

  /**
   * Ferramentas do conector local: operam nas pastas autorizadas na máquina
   * do usuário via túnel WS. Injetadas apenas com o conector online.
   * Timeout maior que o RPC do túnel (20s) para o erro chegar legível.
   */
  private localFilesTools(companyId: string) {
    const op = (path: string) => {
      const url = new URL(`${this.internalApiUrl}/internal/connector/${path}`);
      url.searchParams.set('companyId', companyId);
      return url.toString();
    };
    const base = {
      method: 'POST',
      headers: { 'x-bridge-key': this.bridgeApiKey },
      timeout_ms: 25000,
    };
    const caminho = {
      type: 'string',
      description:
        'Caminho do arquivo/pasta como retornado pelas outras ferramentas arquivos_locais_*',
    };
    const dispositivo = {
      type: 'string',
      description:
        'Nome do computador (dispositivo) alvo. Obrigatório apenas quando houver mais de um conectado — veja arquivos_locais_dispositivos.',
    };
    return [
      {
        ...base,
        name: 'arquivos_locais_dispositivos',
        description:
          'Lista os computadores conectados da empresa e as pastas que cada um compartilha. Use quando precisar saber de qual máquina ler/escrever ou quando houver mais de um dispositivo.',
        url: op('devices'),
        params_schema: { type: 'object', properties: {} },
      },
      {
        ...base,
        name: 'arquivos_locais_listar',
        description:
          'Lista arquivos e pastas do computador do usuário nas pastas autorizadas pelo conector local. Sem "caminho", lista as pastas raiz disponíveis. Use antes de ler ou escrever arquivos locais.',
        url: op('list'),
        params_schema: {
          type: 'object',
          properties: {
            caminho: { ...caminho, description: 'Pasta a listar (opcional)' },
            dispositivo,
          },
        },
      },
      {
        ...base,
        name: 'arquivos_locais_ler',
        description:
          'Lê o conteúdo de um arquivo de texto do computador do usuário (até 256KB). Use o caminho retornado por arquivos_locais_listar ou arquivos_locais_buscar.',
        url: op('read'),
        params_schema: {
          type: 'object',
          properties: { caminho, dispositivo },
          required: ['caminho'],
        },
      },
      {
        ...base,
        name: 'arquivos_locais_buscar',
        description:
          'Busca um termo dentro dos arquivos das pastas autorizadas do computador do usuário e retorna trechos com caminho e linha.',
        url: op('search'),
        params_schema: {
          type: 'object',
          properties: {
            termo: { type: 'string', description: 'Termo a buscar' },
            caminho: {
              ...caminho,
              description: 'Restringir a uma pasta (opcional)',
            },
            dispositivo,
          },
          required: ['termo'],
        },
      },
      {
        ...base,
        name: 'arquivos_locais_escrever',
        description:
          'Cria ou edita um arquivo de texto no computador do usuário, apenas em pastas com escrita habilitada no conector local. Nunca exclui arquivos.',
        url: op('write'),
        params_schema: {
          type: 'object',
          properties: {
            caminho,
            conteudo: {
              type: 'string',
              description: 'Conteúdo completo do arquivo',
            },
            dispositivo,
          },
          required: ['caminho', 'conteudo'],
        },
      },
    ];
  }

  private resolveSandbox(): BridgeSandbox {
    // O processo do agente no servidor fica SEMPRE travado no workspace do
    // tenant (sandbox duro). Acesso a arquivos do usuário é exclusivamente via
    // conector local (tools arquivos_locais_*), nunca abrindo o host do servidor.
    // Os modos custom/free foram removidos da UI — este é o piso de segurança.
    return { mode: 'workspace' };
  }

  /** Cadeia com os provedores fora do ar no fim (último recurso). */
  private healthyFirst(
    companyId: string,
    chain: BridgeChatRequest['provider'][],
  ) {
    return orderByHealth(chain, (p) =>
      providerHealthKey(companyId, p.provider, p.api_key),
    );
  }

  /** Cadeia: provider principal + chaves de reserva (fallbackPriority > 0). */
  private async resolveProviderChain(
    companyId: string,
    capabilities: Prisma.JsonValue,
  ): Promise<BridgeChatRequest['provider'][]> {
    const primary = await this.resolveProvider(companyId, capabilities);
    const chain: BridgeChatRequest['provider'][] = [primary];
    try {
      const backups = await this.providerKeys.fallbackChain(companyId);
      for (const key of backups) {
        const provider = key.provider.toLowerCase();
        // não repete o principal; reserva usa o modelo default da própria chave
        if (provider === primary.provider && key.apiKey === primary.api_key)
          continue;
        const model = key.defaultModel ?? DEFAULT_MODELS[key.provider];
        if (!model) continue;
        chain.push({
          provider,
          model,
          api_key: key.apiKey,
          base_url: key.baseUrl ?? undefined,
        });
      }
    } catch {
      /* fallback é best-effort */
    }
    return chain;
  }

  /**
   * Resolve o provedor de IA da empresa (assinatura tem precedência sobre
   * chave de API). Público para ser reusado por outros fluxos que precisam
   * do mesmo comportamento do chat (ex.: análise de projeto).
   */
  async resolveProvider(
    companyId: string,
    capabilities: Prisma.JsonValue,
  ): Promise<BridgeChatRequest['provider']> {
    const caps = (capabilities ?? {}) as AgentCapabilities;
    const textGen = caps.text_generation;

    // Assinatura ativa tem precedência: sem api_key — os tokens vivem no
    // auth store do tenant (bridge/HERMES_HOME) e o Hermes os resolve.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscriptionProvider: true, subscriptionModel: true },
    });
    if (company?.subscriptionProvider) {
      const model = textGen?.model ?? company.subscriptionModel;
      if (!model) {
        throw new BadRequestException(
          'Defina o modelo da assinatura em Configurações → Provedor',
        );
      }
      return {
        provider: company.subscriptionProvider,
        model,
        api_key: '',
        temperature: textGen?.temperature,
      };
    }

    let keyRecord = null as Awaited<
      ReturnType<ProviderKeysService['getDecrypted']>
    >;
    if (textGen?.provider) {
      const upper = textGen.provider.toUpperCase();
      // o agente pode ter salvo o provider de uma assinatura (ex.:
      // "anthropic-oauth") — só serve como chave se for um Provider de chave
      // válido; senão cai no provider padrão da empresa.
      if ((Object.values(Provider) as string[]).includes(upper)) {
        keyRecord = await this.providerKeys.findByProvider(
          companyId,
          upper as Provider,
        );
      }
    }
    keyRecord = keyRecord ?? (await this.providerKeys.getDecrypted(companyId));
    if (!keyRecord) {
      throw new BadRequestException(
        'Nenhum provedor de IA configurado. Vá em Configurações → Provedores e conecte uma assinatura ou cadastre uma chave de API.',
      );
    }

    const model =
      textGen?.model ??
      keyRecord.defaultModel ??
      DEFAULT_MODELS[keyRecord.provider];
    if (!model) {
      throw new BadRequestException(
        `Defina um modelo nas capabilities do agente para o provider ${keyRecord.provider}`,
      );
    }

    return {
      provider: keyRecord.provider.toLowerCase(),
      model,
      api_key: keyRecord.apiKey,
      base_url: keyRecord.baseUrl ?? undefined,
      temperature: textGen?.temperature,
    };
  }
}
