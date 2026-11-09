import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  Provider,
  ProjectAnalysisStatus,
  TaskPriority,
  TaskStatus,
} from '@prisma/client';
import { LlmClientService } from '../onboarding/llm-client.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BridgeService,
  type BridgeChatRequest,
} from '../conversations/bridge.service';
import { ConversationsService } from '../conversations/conversations.service';

const AI_BACKLOG_LIST = 'Backlog (sugerido pela IA)';
const DOC_TEXT_LIMIT = 20_000;

interface AnalysisResult {
  requirements: string;
  tasks: { title: string; description?: string; priority?: string }[];
}

@Injectable()
export class ProjectAnalysisService {
  private readonly logger = new Logger(ProjectAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmClientService,
    private readonly conversations: ConversationsService,
    private readonly bridge: BridgeService,
  ) {}

  /** Dispara a análise em background; o status do projeto conta o resto. */
  async start(companyId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, companyId },
    });
    if (!project) throw new BadRequestException('Projeto não encontrado');
    if (project.analysisStatus === ProjectAnalysisStatus.RUNNING) {
      throw new ConflictException('Análise já em andamento');
    }
    if (!project.description?.trim()) {
      const docs = await this.prisma.knowledgeDocument.count({
        where: { projectId, status: 'READY' },
      });
      if (docs === 0) {
        throw new BadRequestException(
          'Adicione uma descrição ou um documento pronto antes de analisar',
        );
      }
    }
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        analysisStatus: ProjectAnalysisStatus.RUNNING,
        analysisError: null,
      },
    });
    void this.run(companyId, projectId);
    return { analysisStatus: ProjectAnalysisStatus.RUNNING };
  }

  private async run(companyId: string, projectId: string) {
    try {
      const project = await this.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
      });
      const docText = await this.collectDocumentText(projectId);
      const prompt = this.buildPrompt(
        project.name,
        project.description,
        docText,
      );

      // Mesma resolução de provedor do chat: assinatura tem precedência sobre
      // chave de API. Com chave, chamamos o provedor direto (rápido); com
      // assinatura (api_key vazio), roteamos pelo Hermes, que resolve os tokens.
      const provider = await this.conversations.resolveProvider(companyId, {});
      const raw = provider.api_key
        ? await this.llm.complete({
            provider: provider.provider.toUpperCase() as Provider,
            apiKey: provider.api_key,
            baseUrl: provider.base_url,
            model: provider.model,
            prompt,
          })
        : await this.completeViaBridge(companyId, projectId, provider, prompt);
      const parsed = this.parseResult(raw);

      // lista de backlog do projeto (reusa se a análise for repetida)
      let list = await this.prisma.taskList.findFirst({
        where: { companyId, projectId, name: AI_BACKLOG_LIST },
      });
      list ??= await this.prisma.taskList.create({
        data: { companyId, projectId, name: AI_BACKLOG_LIST },
      });

      for (const t of parsed.tasks.slice(0, 30)) {
        if (!t.title?.trim()) continue;
        await this.prisma.task.create({
          data: {
            companyId,
            projectId,
            listId: list.id,
            title: t.title.slice(0, 300),
            description: t.description?.slice(0, 5000),
            status: TaskStatus.A_FAZER,
            priority: this.parsePriority(t.priority),
            createdByAgent: true,
          },
        });
      }
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          requirements: parsed.requirements,
          analysisStatus: ProjectAnalysisStatus.DONE,
        },
      });
    } catch (err) {
      this.logger.error(
        `análise do projeto ${projectId} falhou: ${(err as Error).message}`,
      );
      await this.prisma.project
        .update({
          where: { id: projectId },
          data: {
            analysisStatus: ProjectAnalysisStatus.ERROR,
            analysisError: (err as Error).message.slice(0, 500),
          },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Análise via Hermes (usado quando o provedor é uma assinatura, cujos tokens
   * vivem no auth store do tenant). É uma conversa de turno único, sem tools:
   * mandamos o prompt e coletamos a resposta final.
   */
  private async completeViaBridge(
    companyId: string,
    projectId: string,
    provider: BridgeChatRequest['provider'],
    prompt: string,
  ): Promise<string> {
    const request: BridgeChatRequest = {
      tenant_id: companyId,
      session_id: `project-analysis:${projectId}`,
      message: prompt,
      file_paths: [],
      tools: [],
      sandbox: { mode: 'workspace' },
      agent: {
        agent_id: 'project-analysis',
        name: 'Equipe de análise',
        system_prompt:
          'Você é a equipe de análise do escritório. Responda exatamente o que for pedido, apenas com o JSON solicitado, sem texto fora do JSON.',
      },
      provider,
    };

    let streamed = '';
    let finalText = '';
    for await (const ev of this.bridge.chat(request)) {
      if (ev.type === 'token_chunk' && ev.text) streamed += ev.text;
      else if (ev.type === 'final_message') finalText = ev.text ?? finalText;
      else if (ev.type === 'error') {
        throw new Error(ev.text || 'Falha ao analisar pela assinatura');
      }
    }
    const out = (finalText || streamed).trim();
    if (!out) throw new Error('A análise não retornou conteúdo');
    return out;
  }

  private async collectDocumentText(projectId: string): Promise<string> {
    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: { document: { projectId, status: 'READY' } },
      orderBy: [{ documentId: 'asc' }, { index: 'asc' }],
      select: { content: true },
    });
    let text = '';
    for (const c of chunks) {
      if (text.length >= DOC_TEXT_LIMIT) break;
      text += c.content + '\n';
    }
    return text.slice(0, DOC_TEXT_LIMIT);
  }

  private buildPrompt(
    name: string,
    description: string | null,
    docText: string,
  ) {
    return `Você é a equipe de análise de um escritório de agentes de IA. Analise o projeto abaixo e produza:
1. Um levantamento de requisitos em markdown (objetivos, requisitos funcionais, não-funcionais, riscos, premissas).
2. Uma lista de tarefas iniciais acionáveis para tirar o projeto do papel.

Projeto: ${name}
Descrição: ${description ?? '(sem descrição)'}
${docText ? `\nDocumento do projeto:\n"""\n${docText}\n"""` : ''}

Responda APENAS com JSON válido neste formato (sem comentários, sem texto fora do JSON):
{
  "requirements": "markdown do levantamento de requisitos",
  "tasks": [
    { "title": "título curto", "description": "detalhe do que fazer", "priority": "BAIXA|MEDIA|ALTA|URGENTE" }
  ]
}`;
  }

  private parseResult(raw: string): AnalysisResult {
    // tolerante: remove cercas de código e pega o primeiro bloco {...}
    const stripped = raw.replace(/```(?:json)?/gi, '').trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('A IA não retornou JSON válido — tente novamente');
    }
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as AnalysisResult;
    if (
      typeof parsed.requirements !== 'string' ||
      !Array.isArray(parsed.tasks)
    ) {
      throw new Error('Resposta da IA em formato inesperado — tente novamente');
    }
    return parsed;
  }

  private parsePriority(value?: string): TaskPriority {
    const upper = value?.toUpperCase() ?? '';
    return (Object.values(TaskPriority) as string[]).includes(upper)
      ? (upper as TaskPriority)
      : TaskPriority.MEDIA;
  }
}
