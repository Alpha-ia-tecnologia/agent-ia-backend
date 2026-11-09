import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Provider, ProviderKey } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { isProviderDown, providerHealthKey } from './provider-health';
import { CreateProviderKeyDto } from './dto/provider-key.dto';

const DEFAULT_BASE_URLS: Partial<Record<Provider, string>> = {
  OPENAI: 'https://api.openai.com/v1',
  DEEPSEEK: 'https://api.deepseek.com/v1',
  OPENROUTER: 'https://openrouter.ai/api/v1',
};

/** Aceita URLs coladas com o caminho completo (ex.: .../v1/chat/completions). */
export function normalizeBaseUrl(url: string): string {
  return url
    .replace(/\/+$/, '')
    .replace(/\/(chat\/)?completions$/, '')
    .replace(/\/models$/, '')
    .replace(/\/+$/, '');
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

@Injectable()
export class ProviderKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async findAll(companyId: string) {
    const [keys, company] = await Promise.all([
      this.prisma.providerKey.findMany({
        where: { companyId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { subscriptionProvider: true },
      }),
    ]);
    // principal = assinatura, se houver; senão a chave mais antiga (mesma
    // regra do chat em resolveProvider)
    const keyIsPrimary = !company?.subscriptionProvider;
    return keys.map((k, i) => {
      const masked = this.toMasked(k);
      return {
        ...masked,
        isPrimary: keyIsPrimary && i === 0,
        isDown: isProviderDown(
          providerHealthKey(companyId, masked.provider, this.decrypt(k)),
        ),
      };
    });
  }

  async create(companyId: string, dto: CreateProviderKeyDto) {
    if (dto.provider === Provider.CUSTOM && !dto.baseUrl) {
      throw new BadRequestException(
        'baseUrl é obrigatório para provider CUSTOM',
      );
    }
    const enc = this.crypto.encrypt(dto.apiKey);
    const key = await this.prisma.providerKey.create({
      data: {
        companyId,
        provider: dto.provider,
        encryptedKey: enc.encrypted,
        iv: enc.iv,
        authTag: enc.authTag,
        baseUrl: dto.baseUrl ? normalizeBaseUrl(dto.baseUrl) : dto.baseUrl,
        defaultModel: dto.defaultModel,
        label: dto.label,
      },
    });
    return this.toMasked(key);
  }

  /** Define a posição da chave na cadeia de reserva (0 = fora). */
  async setFallbackPriority(companyId: string, id: string, priority: number) {
    await this.getOwned(companyId, id);
    const key = await this.prisma.providerKey.update({
      where: { id },
      data: {
        fallbackPriority: Math.max(0, Math.min(9, Math.trunc(priority))),
      },
    });
    return this.toMasked(key);
  }

  /** Chaves de reserva na ordem de prioridade (para o fallback de provider). */
  async fallbackChain(companyId: string) {
    const keys = await this.prisma.providerKey.findMany({
      where: { companyId, fallbackPriority: { gt: 0 } },
      orderBy: { fallbackPriority: 'asc' },
    });
    const out: NonNullable<
      Awaited<ReturnType<ProviderKeysService['getDecrypted']>>
    >[] = [];
    for (const key of keys) {
      const decrypted = await this.getDecrypted(companyId, key.id);
      if (decrypted) out.push(decrypted);
    }
    return out;
  }

  async remove(companyId: string, id: string) {
    await this.getOwned(companyId, id);
    await this.prisma.providerKey.delete({ where: { id } });
    return { deleted: true };
  }

  /** Returns decrypted key record — internal use (onboarding/chat). */
  async getDecrypted(companyId: string, id?: string) {
    const record = id
      ? await this.getOwned(companyId, id)
      : await this.prisma.providerKey.findFirst({
          where: { companyId },
          orderBy: { createdAt: 'asc' },
        });
    if (!record) return null;
    return {
      ...record,
      apiKey: this.crypto.decrypt({
        encrypted: record.encryptedKey,
        iv: record.iv,
        authTag: record.authTag,
      }),
    };
  }

  async findByProvider(companyId: string, provider: Provider) {
    const record = await this.prisma.providerKey.findFirst({
      where: { companyId, provider },
      orderBy: { createdAt: 'asc' },
    });
    if (!record) return null;
    return this.getDecrypted(companyId, record.id);
  }

  async test(companyId: string, id: string) {
    const record = await this.getDecrypted(companyId, id);
    if (!record) throw new NotFoundException('Chave não encontrada');

    let url: string;
    const headers: Record<string, string> = {};

    switch (record.provider) {
      case Provider.ANTHROPIC:
        url = 'https://api.anthropic.com/v1/models';
        headers['x-api-key'] = record.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case Provider.GOOGLE:
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(record.apiKey)}`;
        break;
      default: {
        const base = record.baseUrl ?? DEFAULT_BASE_URLS[record.provider];
        if (!base) {
          throw new BadRequestException(
            'baseUrl não configurada para este provider',
          );
        }
        url = `${base.replace(/\/$/, '')}/models`;
        headers['Authorization'] = `Bearer ${record.apiKey}`;
      }
    }

    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      return {
        ok: res.ok,
        status: res.status,
        message: res.ok
          ? 'Chave válida'
          : `Provider retornou HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: `Falha ao conectar ao provider: ${(err as Error).message}`,
      };
    }
  }

  private async getOwned(companyId: string, id: string) {
    const key = await this.prisma.providerKey.findFirst({
      where: { id, companyId },
    });
    if (!key) throw new NotFoundException('Chave não encontrada');
    return key;
  }

  private decrypt(key: ProviderKey) {
    return this.crypto.decrypt({
      encrypted: key.encryptedKey,
      iv: key.iv,
      authTag: key.authTag,
    });
  }

  private toMasked(key: ProviderKey) {
    const decrypted = this.decrypt(key);
    return {
      id: key.id,
      provider: key.provider.toLowerCase(),
      label: key.label,
      baseUrl: key.baseUrl,
      defaultModel: key.defaultModel,
      fallbackPriority: key.fallbackPriority,
      maskedKey: maskKey(decrypted),
      createdAt: key.createdAt,
    };
  }
}
