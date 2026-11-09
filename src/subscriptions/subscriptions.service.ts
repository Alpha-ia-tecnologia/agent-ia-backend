import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Fala com os endpoints /tenants/{id}/auth/* do bridge. */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly url: string;
  private readonly apiKey: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.url = config.get<string>('BRIDGE_URL') ?? 'http://localhost:8100';
    this.apiKey = (config.get<string>('BRIDGE_API_KEY') ?? '').trim();
  }

  private async bridge(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          'x-bridge-key': this.apiKey,
          ...(init?.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        },
        ...(init?.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
        // falha rápido: um bridge travado seguraria a requisição até o proxy
        // desistir e devolver a própria página de 502 (sem CORS). O início de um
        // fluxo device-code é a exceção — o bridge segura até 45s pelo código.
        signal: AbortSignal.timeout(init?.timeoutMs ?? 8_000),
      });
    } catch {
      throw this.unavailable('Serviço de agentes (bridge) indisponível.');
    }
    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      throw this.unavailable(
        (data.detail as string) ?? `bridge: HTTP ${res.status}`,
      );
    }
    return data;
  }

  // Bridge fora do ar é 424 (Failed Dependency), não 5xx: o proxy do easypanel
  // substitui respostas 5xx pela própria página de erro (sem CORS), então o
  // frontend nunca via a mensagem real. Com 4xx a resposta passa com CORS.
  private unavailable(message: string): HttpException {
    return new HttpException(message, HttpStatus.FAILED_DEPENDENCY);
  }

  // O provider "anthropic-oauth" da AAO vira "anthropic" no lado do Hermes.
  private bridgeProvider(provider: string): string {
    return provider === 'anthropic-oauth' ? 'anthropic' : provider;
  }

  /** Provider no formato do bridge/status (ex.: "anthropic") → formato AAO. */
  static bridgeToAaoProvider(provider: string): string {
    return provider === 'anthropic' ? 'anthropic-oauth' : provider;
  }

  /** Modelo padrão por provider quando a assinatura é auto-ativada ao conectar. */
  private static readonly DEFAULT_MODELS: Record<string, string> = {
    'anthropic-oauth': 'claude-sonnet-4-6',
    'openai-codex': 'gpt-5.1-codex',
    copilot: 'gpt-5',
    nous: 'hermes-4.5',
    'xai-oauth': 'grok-4',
  };

  /**
   * Ativa a assinatura como provider ativo da empresa SE ainda não houver um.
   * Idempotente e não sobrescreve a escolha do usuário — usado quando uma
   * assinatura (OAuth) ou o Claude Code (conector) conecta e nada está ativo,
   * para que "conectar = pronto para montar". `provider` no formato AAO.
   */
  async autoActivateIfIdle(
    companyId: string,
    provider: string,
    userId = 'system',
  ) {
    const model = SubscriptionsService.DEFAULT_MODELS[provider];
    if (!model) return; // provider sem default conhecido → não auto-ativa
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscriptionProvider: true },
    });
    if (company?.subscriptionProvider) return; // já tem provider ativo → respeita
    await this.prisma.company.update({
      where: { id: companyId },
      data: { subscriptionProvider: provider, subscriptionModel: model },
    });
    await this.audit(companyId, userId, 'subscription_activated', {
      provider,
      model,
      auto: true,
    });
    // a instância precisa reprovisionar com o novo provider
    await this.restartTenant(companyId);
    this.logger.log(
      `assinatura ${provider} auto-ativada (tenant ${companyId})`,
    );
  }

  async bridgeStatus(companyId: string) {
    const data = await this.bridge(`/tenants/${companyId}/auth/status`);
    return data.providers as Record<string, { connected: boolean }> | undefined;
  }

  /** Status tolerante a bridge offline: nunca lança — usado no polling do painel. */
  async bridgeStatusSafe(companyId: string) {
    try {
      return await this.bridgeStatus(companyId);
    } catch {
      return undefined;
    }
  }

  async startFlow(companyId: string, provider: string, userId: string) {
    const data = await this.bridge(
      `/tenants/${companyId}/auth/${this.bridgeProvider(provider)}/start`,
      // o bridge espera até 45s pelo device code — não pode estourar em 8s
      { method: 'POST', timeoutMs: 50_000 },
    );
    await this.audit(companyId, userId, 'subscription_flow_started', {
      provider,
    });
    return data;
  }

  async flowStatus(companyId: string, provider: string, userId: string) {
    const data = await this.bridge(
      `/tenants/${companyId}/auth/${this.bridgeProvider(provider)}/flow`,
    );
    if (data.status === 'connected') {
      await this.audit(companyId, userId, 'subscription_connected', {
        provider,
      });
      await this.autoActivateIfIdle(companyId, provider, userId);
    }
    return data;
  }

  anthropicUrl(companyId: string) {
    return this.bridge(`/tenants/${companyId}/auth/anthropic/url`, {
      method: 'POST',
    });
  }

  async anthropicExchange(companyId: string, code: string, userId: string) {
    const data = await this.bridge(
      `/tenants/${companyId}/auth/anthropic/exchange`,
      {
        method: 'POST',
        body: { code },
      },
    );
    await this.audit(companyId, userId, 'subscription_connected', {
      provider: 'anthropic-oauth',
    });
    await this.autoActivateIfIdle(companyId, 'anthropic-oauth', userId);
    return data;
  }

  async removeCredentials(companyId: string, provider: string, userId: string) {
    await this.bridge(
      `/tenants/${companyId}/auth/${this.bridgeProvider(provider)}`,
      { method: 'DELETE' },
    );
    await this.audit(companyId, userId, 'subscription_removed', { provider });
  }

  // provider (bridge/status) -> fonte do conector (checkbox do app desktop)
  private static readonly PROVIDER_TO_SOURCE: Record<string, string> = {
    anthropic: 'claude-code',
    'openai-codex': 'codex-cli',
    copilot: 'gh-token',
  };

  /** Fontes do conector atualmente conectadas — o app desktop espelha isto. */
  async connectedSources(companyId: string): Promise<string[]> {
    const status = await this.bridgeStatusSafe(companyId);
    if (!status) return [];
    return Object.entries(SubscriptionsService.PROVIDER_TO_SOURCE)
      .filter(([provider]) => status[provider]?.connected)
      .map(([, source]) => source);
  }

  /**
   * Desconecta uma assinatura: remove no bridge e, se ela era o provider ativo,
   * limpa a ativação (reprovisiona). Reutilizado pelo controller e pelo gateway
   * do conector (quando o usuário desmarca a credencial no app desktop).
   */
  async disconnectProvider(
    companyId: string,
    provider: string,
    userId = 'system',
  ) {
    await this.removeCredentials(companyId, provider, userId);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscriptionProvider: true },
    });
    if (company?.subscriptionProvider === provider) {
      await this.prisma.company.update({
        where: { id: companyId },
        data: { subscriptionProvider: null, subscriptionModel: null },
      });
      await this.restartTenant(companyId);
    }
  }

  async restartTenant(companyId: string) {
    try {
      await this.bridge(`/tenants/${companyId}/stop`, { method: 'POST' });
    } catch (err) {
      this.logger.warn(`restartTenant falhou: ${(err as Error).message}`);
    }
  }

  /** Trilha de auditoria das ações de assinatura (aba Auditoria). */
  async audit(
    companyId: string,
    userId: string,
    type: string,
    payload: Record<string, unknown>,
  ) {
    await this.prisma.orchestrationEvent
      .create({
        data: {
          companyId,
          type,
          payload: { ...payload, userId },
        },
      })
      .catch(() => undefined);
  }
}
