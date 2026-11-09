import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Provider, ProviderKey } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

type DecryptedKey = ProviderKey & { apiKey: string };

/** A chave do servidor não existe no banco; este é o id dela nas telas. */
const SERVER_KEY_ID = 'servidor';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

@Injectable()
export class ProviderKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * A IA usa só a chave definida no servidor (ANTHROPIC_API_KEY): a plataforma
   * não tem cadastro de chaves.
   */
  private serverKey(companyId: string): DecryptedKey | null {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY')?.trim();
    if (!apiKey) return null;
    return {
      id: SERVER_KEY_ID,
      companyId,
      provider: Provider.ANTHROPIC,
      encryptedKey: '',
      iv: '',
      authTag: '',
      baseUrl: null,
      defaultModel:
        this.config.get<string>('ANTHROPIC_MODEL')?.trim() || DEFAULT_MODEL,
      label: 'Anthropic',
      fallbackPriority: 0,
      createdAt: new Date(0),
      apiKey,
    };
  }

  findAll(companyId: string) {
    const key = this.serverKey(companyId);
    if (!key) return [];
    return [
      {
        id: key.id,
        provider: key.provider.toLowerCase(),
        label: key.label,
        baseUrl: key.baseUrl,
        defaultModel: key.defaultModel,
        fallbackPriority: key.fallbackPriority,
        maskedKey: '****',
        createdAt: key.createdAt,
        isPrimary: true,
        isDown: false,
      },
    ];
  }

  /** Chaves de reserva na ordem de prioridade (para o fallback de provider). */
  async fallbackChain(companyId: string) {
    const keys = await this.prisma.providerKey.findMany({
      where: { companyId, fallbackPriority: { gt: 0 } },
      orderBy: { fallbackPriority: 'asc' },
    });
    const out: DecryptedKey[] = [];
    for (const key of keys) {
      const decrypted = await this.getDecrypted(companyId, key.id);
      if (decrypted) out.push(decrypted);
    }
    return out;
  }

  /** Returns decrypted key record — internal use (onboarding/chat). */
  async getDecrypted(
    companyId: string,
    id?: string,
  ): Promise<DecryptedKey | null> {
    if (!id || id === SERVER_KEY_ID) return this.serverKey(companyId);
    const record = await this.getOwned(companyId, id);
    return {
      ...record,
      apiKey: this.crypto.decrypt({
        encrypted: record.encryptedKey,
        iv: record.iv,
        authTag: record.authTag,
      }),
    };
  }

  findByProvider(companyId: string, provider: Provider) {
    return Promise.resolve(
      provider === Provider.ANTHROPIC ? this.serverKey(companyId) : null,
    );
  }

  private async getOwned(companyId: string, id: string) {
    const key = await this.prisma.providerKey.findFirst({
      where: { id, companyId },
    });
    if (!key) throw new NotFoundException('Chave não encontrada');
    return key;
  }
}
