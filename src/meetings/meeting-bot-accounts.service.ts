import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

/** Provedores de conta que o bot sabe usar. */
export type BotProvider = 'GOOGLE' | 'MICROSOFT';

/** Plataforma da reunião → provedor da conta que o bot precisa. */
export function providerForPlatform(platform: 'TEAMS' | 'MEET'): BotProvider {
  return platform === 'MEET' ? 'GOOGLE' : 'MICROSOFT';
}

/** Provedores cuja conta é OBRIGATÓRIA hoje (gating). Google primeiro; Teams em seguida. */
const ENFORCED_PROVIDERS: ReadonlySet<BotProvider> = new Set(['GOOGLE']);

export interface ConnectBotAccountDto {
  provider: BotProvider;
  /** storageState do Playwright (JSON serializado), gerado no onboarding assistido. */
  storageState: string;
  email?: string;
}

/** Visão segura (sem o storageState) para o cliente/painel. */
export interface BotAccountView {
  id: string;
  provider: BotProvider;
  email: string | null;
  status: string;
  lastValidatedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}

/**
 * Contas Google/Microsoft por empresa que o bot usa para entrar logado nas
 * reuniões. O storageState fica cifrado (AES-256-GCM) e nunca sai por rotas
 * públicas — só o worker (aao-scribe) o obtém decifrado via endpoint interno
 * protegido por x-bridge-key.
 */
@Injectable()
export class MeetingBotAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  // --- Login hospedado (aao-login): sobe um browser streamado para o admin
  //     logar na conta do escritório e captura a sessão sem terminal. ---

  private loginInternalUrl(): string {
    return (
      this.config.get<string>('AAO_LOGIN_INTERNAL_URL') ??
      'http://localhost:4000'
    ).replace(/\/$/, '');
  }

  private loginPublicWsUrl(): string {
    return (
      this.config.get<string>('AAO_LOGIN_PUBLIC_WS_URL') ??
      'ws://localhost:4000'
    ).replace(/\/$/, '');
  }

  private bridgeHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-bridge-key': (this.config.get<string>('BRIDGE_API_KEY') ?? '').trim(),
    };
  }

  /** Abre uma sessão de login streamada; devolve ao painel o WS + token único. */
  async startConnectSession(
    provider: BotProvider,
  ): Promise<{ sessionId: string; token: string; wsUrl: string }> {
    if (provider !== 'GOOGLE' && provider !== 'MICROSOFT') {
      throw new BadRequestException('Provider deve ser GOOGLE ou MICROSOFT.');
    }
    let res: Response;
    try {
      res = await fetch(`${this.loginInternalUrl()}/sessions`, {
        method: 'POST',
        headers: this.bridgeHeaders(),
        body: JSON.stringify({ provider }),
      });
    } catch {
      throw new BadRequestException(
        'Serviço de login (aao-login) indisponível.',
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        'Não foi possível abrir a sessão de login.',
      );
    }
    const body = (await res.json()) as { id: string; token: string };
    return {
      sessionId: body.id,
      token: body.token,
      wsUrl: `${this.loginPublicWsUrl()}/sessions/${body.id}/stream?token=${body.token}`,
    };
  }

  /** Captura a sessão logada, salva como conta do escritório e derruba o browser. */
  async finishConnectSession(
    companyId: string,
    sessionId: string,
    token: string,
    provider: BotProvider,
    email?: string,
  ): Promise<BotAccountView> {
    let res: Response;
    try {
      res = await fetch(
        `${this.loginInternalUrl()}/sessions/${sessionId}/capture`,
        {
          method: 'POST',
          headers: this.bridgeHeaders(),
          body: JSON.stringify({ token }),
        },
      );
    } catch {
      throw new BadRequestException(
        'Serviço de login (aao-login) indisponível.',
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        'Não foi possível capturar a sessão. Refaça o login.',
      );
    }
    const { storageState } = (await res.json()) as { storageState: string };
    const view = await this.connect(companyId, {
      provider,
      storageState,
      email,
    });
    await this.cancelConnectSession(sessionId).catch(() => undefined);
    return view;
  }

  /** Derruba a sessão de login (cancelamento ou limpeza). */
  async cancelConnectSession(sessionId: string): Promise<void> {
    await fetch(`${this.loginInternalUrl()}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.bridgeHeaders(),
    }).catch(() => undefined);
  }

  private toView(a: {
    id: string;
    provider: string;
    email: string | null;
    status: string;
    lastValidatedAt: Date | null;
    lastError: string | null;
    updatedAt: Date;
  }): BotAccountView {
    return {
      id: a.id,
      provider: a.provider as BotProvider,
      email: a.email,
      status: a.status,
      lastValidatedAt: a.lastValidatedAt,
      lastError: a.lastError,
      updatedAt: a.updatedAt,
    };
  }

  /** Lista as contas conectadas da empresa (sem segredos). */
  async list(companyId: string): Promise<BotAccountView[]> {
    const rows = await this.prisma.meetingBotAccount.findMany({
      where: { companyId, removedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * Conecta (ou reconecta) a conta de um provedor. Uma conexão ativa por
   * (empresa, provedor): reconectar sobrescreve a anterior. Valida que o
   * storageState é um JSON plausível do Playwright antes de cifrar.
   */
  async connect(
    companyId: string,
    dto: ConnectBotAccountDto,
  ): Promise<BotAccountView> {
    if (dto.provider !== 'GOOGLE' && dto.provider !== 'MICROSOFT') {
      throw new BadRequestException('Provider deve ser GOOGLE ou MICROSOFT.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dto.storageState);
    } catch {
      throw new BadRequestException('storageState inválido: não é JSON.');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('cookies' in parsed) ||
      !Array.isArray(parsed.cookies)
    ) {
      throw new BadRequestException(
        'storageState inválido: esperado JSON do Playwright com "cookies".',
      );
    }

    const enc = this.crypto.encrypt(dto.storageState);
    const existing = await this.prisma.meetingBotAccount.findFirst({
      where: { companyId, provider: dto.provider, removedAt: null },
    });

    const data = {
      email: dto.email ?? null,
      encryptedState: enc.encrypted,
      iv: enc.iv,
      authTag: enc.authTag,
      status: 'CONNECTED',
      lastError: null,
      lastValidatedAt: new Date(),
    };

    const row = existing
      ? await this.prisma.meetingBotAccount.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.meetingBotAccount.create({
          data: { companyId, provider: dto.provider, ...data },
        });
    return this.toView(row);
  }

  /** Desconecta (soft delete) a conta pelo id, dentro do escopo da empresa. */
  async disconnect(companyId: string, id: string): Promise<{ ok: true }> {
    const row = await this.prisma.meetingBotAccount.findFirst({
      where: { id, companyId, removedAt: null },
    });
    if (!row) throw new NotFoundException('Conta não encontrada.');
    await this.prisma.meetingBotAccount.update({
      where: { id },
      data: { removedAt: new Date(), status: 'DISCONNECTED' },
    });
    return { ok: true };
  }

  /** Conta CONNECTED da empresa para um provedor (ou null). Uso interno. */
  findConnected(companyId: string, provider: BotProvider) {
    return this.prisma.meetingBotAccount.findFirst({
      where: { companyId, provider, status: 'CONNECTED', removedAt: null },
    });
  }

  /**
   * Gating: garante que a empresa tem conta conectada para a plataforma da
   * reunião. Só bloqueia provedores em ENFORCED_PROVIDERS (hoje: Google/Meet).
   * Retorna o botAccountId a anexar no job, ou undefined quando não obrigatório
   * e não conectado (ex.: Teams anônimo enquanto a fase do Teams não chega).
   */
  async requireForPlatform(
    companyId: string,
    platform: 'TEAMS' | 'MEET',
  ): Promise<string | undefined> {
    const provider = providerForPlatform(platform);
    const account = await this.findConnected(companyId, provider);
    if (account) return account.id;
    if (ENFORCED_PROVIDERS.has(provider)) {
      const nome = provider === 'GOOGLE' ? 'Google' : 'Microsoft';
      throw new BadRequestException(
        `Conecte a conta ${nome} do escritório em Integrações de reunião para usar reuniões do ${
          platform === 'MEET' ? 'Google Meet' : 'Teams'
        }.`,
      );
    }
    return undefined;
  }

  /**
   * Retorna o storageState DECIFRADO de uma conta. EXCLUSIVO do endpoint
   * interno consumido pelo worker (protegido por x-bridge-key). Nunca exponha
   * isto em rota pública.
   */
  async getDecryptedState(botAccountId: string): Promise<string> {
    const row = await this.prisma.meetingBotAccount.findFirst({
      where: { id: botAccountId, removedAt: null },
    });
    if (!row) throw new NotFoundException('Conta não encontrada.');
    return this.crypto.decrypt({
      encrypted: row.encryptedState,
      iv: row.iv,
      authTag: row.authTag,
    });
  }

  /** Marca a conta como expirada (chamado pelo worker quando a sessão falha). */
  async markExpired(botAccountId: string, error?: string): Promise<void> {
    await this.prisma.meetingBotAccount
      .update({
        where: { id: botAccountId },
        data: { status: 'EXPIRED', lastError: error?.slice(0, 500) ?? null },
      })
      .catch(() => undefined);
  }
}
