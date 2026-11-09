import { Injectable, Logger } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderKeysService } from '../provider-keys/provider-keys.service';

const BATCH_SIZE = 64;
const MAX_INPUT_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Providers que expõem API de embeddings (CUSTOM = OpenAI-compatible). */
export const EMBEDDING_PROVIDERS: Provider[] = [
  Provider.OPENAI,
  Provider.GOOGLE,
  Provider.CUSTOM,
];

export interface EmbeddingConfig {
  keyId: string;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string | null;
}

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerKeys: ProviderKeysService,
  ) {}

  /** Config de embeddings da empresa, ou null quando não configurada/compatível. */
  async getConfig(companyId: string): Promise<EmbeddingConfig | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { embeddingKeyId: true, embeddingModel: true },
    });
    if (!company?.embeddingKeyId || !company.embeddingModel) return null;
    const key = await this.providerKeys
      .getDecrypted(companyId, company.embeddingKeyId)
      .catch(() => null);
    if (!key || !EMBEDDING_PROVIDERS.includes(key.provider)) return null;
    return {
      keyId: key.id,
      provider: key.provider,
      model: company.embeddingModel,
      apiKey: key.apiKey,
      baseUrl: key.baseUrl,
    };
  }

  async embedQuery(cfg: EmbeddingConfig, text: string): Promise<number[]> {
    const [vec] = await this.embed(cfg, [text]);
    return vec;
  }

  /** Embeda textos em lotes; retorna vetores na mesma ordem da entrada. */
  async embed(cfg: EmbeddingConfig, texts: string[]): Promise<number[][]> {
    const inputs = texts.map((t) => t.slice(0, MAX_INPUT_CHARS));
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE);
      out.push(...(await this.embedBatchWithRetry(cfg, batch)));
    }
    return out;
  }

  private async embedBatchWithRetry(
    cfg: EmbeddingConfig,
    batch: string[],
  ): Promise<number[][]> {
    try {
      return await this.embedBatch(cfg, batch);
    } catch (err) {
      this.logger.warn(
        `embedding batch falhou (1ª tentativa): ${(err as Error).message}`,
      );
      await new Promise((r) => setTimeout(r, 2000));
      return this.embedBatch(cfg, batch);
    }
  }

  private embedBatch(cfg: EmbeddingConfig, batch: string[]) {
    return cfg.provider === Provider.GOOGLE
      ? this.embedGoogle(cfg, batch)
      : this.embedOpenAiCompatible(cfg, batch);
  }

  private async embedOpenAiCompatible(
    cfg: EmbeddingConfig,
    batch: string[],
  ): Promise<number[][]> {
    const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: batch }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    return [...json.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  private async embedGoogle(
    cfg: EmbeddingConfig,
    batch: string[],
  ): Promise<number[][]> {
    const model = cfg.model.startsWith('models/')
      ? cfg.model
      : `models/${cfg.model}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents?key=${encodeURIComponent(cfg.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: batch.map((text) => ({
          model,
          content: { parts: [{ text }] },
        })),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      embeddings: { values: number[] }[];
    };
    return json.embeddings.map((e) => e.values);
  }
}
