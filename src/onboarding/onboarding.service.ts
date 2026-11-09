import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnboardingStatus, Prisma } from '@prisma/client';
import { AgentsService, genderedSeed, slugify } from '../agents/agents.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderKeysService } from '../provider-keys/provider-keys.service';
import { BridgeService } from '../conversations/bridge.service';
import { ProviderResolverService } from '../provider-keys/provider-resolver.service';
import { LlmClientService } from './llm-client.service';
import { parseAgentsJson, SuggestedAgent } from './llm-json.parser';

const MASTER_PROMPT = (
  companyName: string,
  industry: string,
  description: string,
) =>
  `
Você é um consultor especialista em montar equipes de agentes de IA para empresas.

Empresa: ${companyName}
Setor: ${industry || 'não informado'}
Descrição do negócio: ${description}

Monte o escritório ideal de agentes de IA para essa empresa. Gere entre 4 e 6 agentes especializados,
cada um adequado às necessidades reais do negócio descrito (ex.: financeiro, marketing, jurídico,
atendimento, operações, vendas — escolha o que fizer sentido).

Responda APENAS com JSON estrito, sem comentários e sem texto fora do JSON, neste formato exato:
{
  "agents": [
    {
      "name": "Nome próprio em português (ex: Sofia, Ricardo)",
      "role": "Cargo/função curta (ex: Analista Financeira)",
      "department": "Nome do setor (ex: Financeiro)",
      "systemPrompt": "Instruções completas em português definindo persona, responsabilidades, tom e limites do agente",
      "avatarSeed": "string-curta-kebab-case"
    }
  ]
}
`.trim();

const SINGLE_AGENT_PROMPT = (
  companyName: string,
  industry: string,
  businessDescription: string,
  request: string,
  existing: string,
  departments: string,
) =>
  `
Você é um consultor especialista em criar agentes de IA para empresas.

Empresa: ${companyName}
Setor: ${industry || 'não informado'}
Descrição do negócio: ${businessDescription || 'não informada'}
Agentes já existentes no escritório: ${existing || 'nenhum'}
Setores já existentes: ${departments || 'nenhum'}

O usuário pediu o(s) seguinte(s) agente(s):
"${request}"

Crie o(s) agente(s) que atendem esse pedido (gere 1 agente, ou mais somente se o pedido
claramente descrever mais de um). Aproveite setores existentes quando fizer sentido e não
repita agentes que já existem.

Responda APENAS com JSON estrito, sem comentários e sem texto fora do JSON, neste formato exato:
{
  "agents": [
    {
      "name": "Nome próprio em português (ex: Sofia, Ricardo)",
      "role": "Cargo/função curta (ex: Analista Financeira)",
      "department": "Nome do setor (ex: Financeiro)",
      "systemPrompt": "Instruções completas em português definindo persona, responsabilidades, tom e limites do agente",
      "avatarSeed": "string-curta-kebab-case"
    }
  ]
}
`.trim();

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerKeys: ProviderKeysService,
    private readonly resolver: ProviderResolverService,
    private readonly bridge: BridgeService,
    private readonly llm: LlmClientService,
    private readonly agents: AgentsService,
  ) {}

  /** Completa um prompt pelo provider ativo: chave (HTTP direto) ou
   *  assinatura (via bridge/Hermes, que resolve os tokens do tenant). */
  private async completeWithActiveProvider(
    companyId: string,
    prompt: string,
  ): Promise<string> {
    const active = await this.resolver.active(companyId);
    if (!active) {
      throw new BadRequestException(
        'Conecte um provedor de IA (assinatura ou chave) antes de gerar com IA',
      );
    }
    if (active.type === 'key') {
      return this.llm.complete({
        provider: active.key.provider,
        apiKey: active.key.apiKey,
        baseUrl: active.key.baseUrl,
        model: active.key.defaultModel ?? undefined,
        prompt,
      });
    }
    // assinatura: uma "conversa" descartável pelo bridge
    const parts: string[] = [];
    for await (const event of this.bridge.chat({
      tenant_id: companyId,
      session_id: `onboarding-${Date.now().toString(36)}`,
      message: prompt,
      file_paths: [],
      tools: [],
      sandbox: { mode: 'workspace' },
      agent: {
        agent_id: 'onboarding',
        name: 'Gerador',
        system_prompt:
          'Responda SOMENTE com o JSON pedido, sem markdown, sem comentários e sem texto fora do JSON.',
      },
      provider: {
        provider: active.provider,
        model: active.model,
        api_key: '',
      },
    })) {
      if (event.type === 'final_message' && event.text) parts.push(event.text);
      if (event.type === 'error') {
        throw new BadRequestException(
          `Falha na geração via assinatura: ${event.text ?? 'erro'}`,
        );
      }
    }
    return parts.join('');
  }

  /**
   * Completa o prompt pelo provider ativo e faz o parse dos agentes, com
   * robustez a modelos que não respeitam "só JSON" (comum em assinaturas):
   * loga a resposta crua no parse falho, tenta de novo reforçando o formato e,
   * se esgotar, devolve um erro amigável (4xx) em vez de 500 cru.
   */
  private async generateAgents(
    companyId: string,
    basePrompt: string,
  ): Promise<SuggestedAgent[]> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\nATENÇÃO: sua resposta anterior NÃO veio em JSON válido. Responda AGORA apenas com o objeto JSON pedido, começando com "{" e terminando com "}", sem markdown, sem comentários e sem qualquer texto fora do JSON.`;
      const raw = await this.completeWithActiveProvider(companyId, prompt);
      try {
        return parseAgentsJson(raw);
      } catch (err) {
        this.logger.warn(
          `geração de agentes: parse falhou (tentativa ${attempt}/${MAX_ATTEMPTS}): ${(err as Error).message} · resposta crua (300): ${raw
            .slice(0, 300)
            .replace(/\s+/g, ' ')
            .trim()}`,
        );
      }
    }
    throw new BadRequestException(
      'A IA não retornou os agentes no formato esperado. Tente novamente. Se persistir, conecte outro provedor (ex.: uma chave de API) em Configurações → Provedores.',
    );
  }

  async generate(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Empresa não encontrada');
    if (!company.businessDescription) {
      throw new BadRequestException(
        'Preencha a descrição do negócio antes de gerar o escritório',
      );
    }

    const suggested = await this.generateAgents(
      companyId,
      MASTER_PROMPT(
        company.name,
        company.industry ?? '',
        company.businessDescription,
      ),
    );

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        onboardingStatus: OnboardingStatus.GENERATED,
        onboardingDraft: suggested as unknown as Prisma.InputJsonValue,
      },
    });

    return { agents: suggested };
  }

  /** Gera sugestões de agente(s) a partir de uma descrição livre do usuário. */
  async generateAgentDraft(companyId: string, request: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Empresa não encontrada');

    const [agents, departments] = await Promise.all([
      this.prisma.agent.findMany({
        where: { companyId, isActive: true },
        select: { name: true, role: true },
      }),
      this.prisma.department.findMany({
        where: { companyId },
        select: { name: true },
      }),
    ]);
    return {
      agents: await this.generateAgents(
        companyId,
        SINGLE_AGENT_PROMPT(
          company.name,
          company.industry ?? '',
          company.businessDescription ?? '',
          request,
          agents.map((a) => `${a.name} (${a.role ?? 'sem cargo'})`).join(', '),
          departments.map((d) => d.name).join(', '),
        ),
      ),
    };
  }

  /** Cria um agente a partir de uma sugestão (resolve o setor por nome). */
  async createFromSuggestion(companyId: string, agent: SuggestedAgent) {
    let departmentId: string | undefined;
    const depName = agent.department?.trim();
    if (depName) {
      const existing = await this.prisma.department.findFirst({
        where: { companyId, name: depName },
      });
      const dep =
        existing ??
        (await this.prisma.department.create({
          data: { companyId, name: depName },
        }));
      departmentId = dep.id;
    }
    return this.agents.create(companyId, {
      name: agent.name,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      avatarSeed: agent.avatarSeed,
      departmentId,
    });
  }

  async confirm(companyId: string, agents: SuggestedAgent[]) {
    if (!agents.length) {
      throw new BadRequestException('Lista de agentes vazia');
    }

    // Departments (dedup by name)
    const departmentNames = [
      ...new Set(agents.map((a) => a.department.trim()).filter(Boolean)),
    ];
    const departmentIdByName = new Map<string, string>();
    for (const name of departmentNames) {
      const existing = await this.prisma.department.findFirst({
        where: { companyId, name },
      });
      const dep =
        existing ??
        (await this.prisma.department.create({ data: { companyId, name } }));
      departmentIdByName.set(name, dep.id);
    }

    const created: Awaited<ReturnType<AgentsService['create']>>[] = [];
    for (const a of agents) {
      created.push(
        await this.agents.create(companyId, {
          name: a.name,
          role: a.role,
          description: a.role,
          systemPrompt: a.systemPrompt,
          avatarSeed: a.avatarSeed || genderedSeed(a.name, slugify(a.name)),
          departmentId: departmentIdByName.get(a.department.trim()),
        }),
      );
    }

    // Agente Gerente (orquestrador)
    const roster = agents
      .map((a) => `- ${a.name} (${a.role}, setor ${a.department})`)
      .join('\n');
    const managerExists = await this.prisma.agent.findFirst({
      where: { companyId, isManager: true },
    });
    let manager = managerExists;
    if (!manager) {
      const managerBase = await this.agents.create(companyId, {
        name: 'Agente Gerente',
        role: 'Gerente do Escritório',
        description:
          'Orquestrador: entende a demanda e delega para o agente certo.',
        avatarSeed: 'agente-gerente',
        systemPrompt: `Você é o Agente Gerente, o orquestrador do escritório de agentes de IA desta empresa.
Seu papel é entender a demanda do usuário e delegar para o agente especialista mais adequado, citando-o pelo nome.
Equipe disponível:
${roster}

Regras:
- Saudações e perguntas simples: responda você mesmo, em poucas frases.
- Demandas de um setor: acione o especialista certo pela ferramenta especialista_acionar (um ou mais).
- Consolide o que a equipe entregou numa resposta final objetiva, em português, com tom profissional e sem emojis.`,
      });
      manager = await this.prisma.agent.update({
        where: { id: managerBase.id },
        data: { isManager: true },
      });
    }

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        onboardingStatus: OnboardingStatus.COMPLETED,
        onboardingDraft: Prisma.JsonNull,
      },
    });

    return { agents: created, manager };
  }
}
