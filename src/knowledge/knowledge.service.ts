import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { KnowledgeStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  EMBEDDING_PROVIDERS,
  EmbeddingConfig,
  EmbeddingsService,
} from './embeddings.service';

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const SEARCH_LIMIT = 6;
const SNIPPET_MAX = 1200;
const CANDIDATE_LIMIT = 12; // por ramo (lexical/vetorial) antes do RRF
const RRF_K = 60;

export interface KnowledgeSearchHit {
  documentTitle: string;
  content: string;
  rank: number;
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  /** Empresas com reindex em andamento (sem fila: evita reindex concorrente). */
  private readonly reindexing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  list(companyId: string) {
    return this.prisma.knowledgeDocument.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { agent: { select: { id: true, name: true } } },
    });
  }

  async upload(
    companyId: string,
    file: { originalname: string; buffer: Buffer; mimetype: string },
    agentId?: string,
    projectId?: string,
  ) {
    await this.ensureAgent(companyId, agentId);

    const safeName = `${Date.now()}-${file.originalname.replace(/[^\w.-]+/g, '_')}`;
    const objectName = `${companyId}/knowledge/${safeName}`;
    await this.storage.upload(objectName, file.buffer, file.mimetype);

    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        companyId,
        agentId: agentId ?? null,
        projectId: projectId ?? null,
        title: file.originalname,
        objectName,
        mimeType: file.mimetype,
      },
    });

    // Extração e indexação em background: o upload responde na hora e o
    // status do documento (PROCESSING → READY/ERROR) conta o resto.
    void this.process(doc.id, file);
    return doc;
  }

  async addText(
    companyId: string,
    title: string,
    content: string,
    agentId?: string,
  ) {
    await this.ensureAgent(companyId, agentId);
    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        companyId,
        agentId: agentId ?? null,
        title,
        objectName: '', // conteúdo inline: não há arquivo no storage
        mimeType: 'text/plain',
      },
    });
    void this.processText(doc.id, content);
    return doc;
  }

  async addUrl(companyId: string, url: string, agentId?: string) {
    await this.ensureAgent(companyId, agentId);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('URL inválida');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Apenas links http(s) são aceitos');
    }

    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        companyId,
        agentId: agentId ?? null,
        title: url,
        objectName: '',
        mimeType: 'text/html',
      },
    });

    void (async () => {
      try {
        const res = await fetch(parsed.toString(), {
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
          headers: { 'user-agent': 'AAO-KnowledgeBot/1.0' },
        });
        if (!res.ok) throw new Error(`página retornou HTTP ${res.status}`);
        const html = await res.text();
        const pageTitle = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1];
        if (pageTitle) {
          await this.prisma.knowledgeDocument.update({
            where: { id: doc.id },
            data: { title: `${pageTitle.trim()} — ${parsed.hostname}` },
          });
        }
        await this.processText(doc.id, this.htmlToText(html));
      } catch (err) {
        await this.prisma.knowledgeDocument
          .update({
            where: { id: doc.id },
            data: {
              status: KnowledgeStatus.ERROR,
              error: `Falha ao ler o link: ${(err as Error).message}`.slice(
                0,
                500,
              ),
            },
          })
          .catch(() => undefined);
      }
    })();
    return doc;
  }

  async remove(companyId: string, id: string) {
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id, companyId },
    });
    if (!doc) throw new NotFoundException('Documento não encontrado');
    await this.prisma.knowledgeDocument.delete({ where: { id } });
    if (doc.objectName) {
      await this.storage.remove(doc.objectName).catch(() => undefined);
    }
    return { deleted: true };
  }

  async hasReadyDocuments(companyId: string): Promise<boolean> {
    const count = await this.prisma.knowledgeDocument.count({
      where: { companyId, status: KnowledgeStatus.READY },
    });
    return count > 0;
  }

  /**
   * Busca híbrida: lexical (tsvector português) + vetorial (pgvector, quando a
   * empresa tem embeddings configurados), mescladas por Reciprocal Rank Fusion.
   * agentId amplia para docs do agente.
   */
  async search(
    companyId: string,
    query: string,
    agentId?: string,
  ): Promise<KnowledgeSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const agentFilter = agentId ?? '';

    const [lexical, vector] = await Promise.all([
      this.searchLexical(companyId, q, agentFilter),
      this.searchVector(companyId, q, agentFilter),
    ]);

    // RRF: score = soma de 1/(K + posição) em cada ranking; dedupe por chunk.
    const fused = new Map<
      string,
      { title: string; content: string; score: number }
    >();
    for (const ranking of [lexical, vector]) {
      ranking.forEach((row, i) => {
        const entry = fused.get(row.id) ?? {
          title: row.title,
          content: row.content,
          score: 0,
        };
        entry.score += 1 / (RRF_K + i + 1);
        fused.set(row.id, entry);
      });
    }
    const merged = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_LIMIT)
      .map((r) => ({
        documentTitle: r.title,
        content: r.content.slice(0, SNIPPET_MAX),
        rank: r.score,
      }));
    if (merged.length > 0) return merged;

    // Fallback: termos soltos via ILIKE (cobre nomes próprios/códigos que o
    // stemmer português não casa).
    const like = `%${q.split(/\s+/).slice(0, 3).join('%')}%`;
    const fallback = await this.prisma.$queryRaw<
      { title: string; content: string }[]
    >`
      SELECT d."title", c."content"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE c."companyId" = ${companyId}
        AND d."status" = 'READY'
        AND (d."agentId" IS NULL OR d."agentId" = ${agentFilter})
        AND c."content" ILIKE ${like}
      LIMIT ${SEARCH_LIMIT}
    `;
    return fallback.map((r) => ({
      documentTitle: r.title,
      content: r.content.slice(0, SNIPPET_MAX),
      rank: 0,
    }));
  }

  private searchLexical(companyId: string, q: string, agentFilter: string) {
    return this.prisma.$queryRaw<
      { id: string; title: string; content: string }[]
    >`
      SELECT c."id", d."title", c."content"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
      WHERE c."companyId" = ${companyId}
        AND d."status" = 'READY'
        AND (d."agentId" IS NULL OR d."agentId" = ${agentFilter})
        AND c."tsv" @@ websearch_to_tsquery('portuguese', ${q})
      ORDER BY ts_rank(c."tsv", websearch_to_tsquery('portuguese', ${q})) DESC
      LIMIT ${CANDIDATE_LIMIT}
    `;
  }

  private async searchVector(
    companyId: string,
    q: string,
    agentFilter: string,
  ): Promise<{ id: string; title: string; content: string }[]> {
    try {
      const cfg = await this.embeddings.getConfig(companyId);
      if (!cfg) return [];
      const queryVec = await this.embeddings.embedQuery(cfg, q);
      const literal = JSON.stringify(queryVec);
      // filtro por embeddingModel é obrigatório: comparar vetores de dimensões
      // diferentes é erro SQL no pgvector
      return await this.prisma.$queryRaw<
        { id: string; title: string; content: string }[]
      >`
        SELECT c."id", d."title", c."content"
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
        WHERE c."companyId" = ${companyId}
          AND d."status" = 'READY'
          AND (d."agentId" IS NULL OR d."agentId" = ${agentFilter})
          AND c."embedding" IS NOT NULL
          AND c."embeddingModel" = ${cfg.model}
        ORDER BY c."embedding" <=> ${literal}::vector
        LIMIT ${CANDIDATE_LIMIT}
      `;
    } catch (err) {
      // Vetorial é best-effort: qualquer falha degrada para lexical.
      this.logger.warn(
        `busca vetorial falhou para ${companyId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  // ---- embeddings -----------------------------------------------------------

  /** Define (ou remove, com keyId null) a config de embeddings da empresa. */
  async setEmbeddingConfig(
    companyId: string,
    keyId: string | null,
    model: string | null,
  ) {
    if (keyId) {
      if (!model?.trim()) {
        throw new BadRequestException('Informe o modelo de embeddings');
      }
      const key = await this.prisma.providerKey.findFirst({
        where: { id: keyId, companyId },
        select: { provider: true },
      });
      if (!key) throw new NotFoundException('Chave não encontrada');
      if (!EMBEDDING_PROVIDERS.includes(key.provider)) {
        throw new BadRequestException(
          'Este provider não oferece API de embeddings (use OpenAI, Google ou uma API OpenAI-compatível)',
        );
      }
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        embeddingKeyId: keyId,
        embeddingModel: keyId ? model?.trim() : null,
      },
    });
    return this.embeddingStats(companyId);
  }

  /** Cobertura de embeddings da empresa (para a UI de "Busca inteligente"). */
  async embeddingStats(companyId: string) {
    const [company, total, embedded] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { embeddingKeyId: true, embeddingModel: true },
      }),
      this.prisma.knowledgeChunk.count({ where: { companyId } }),
      this.prisma.knowledgeChunk.count({
        where: { companyId, NOT: { embeddingModel: null } },
      }),
    ]);
    const cfg = await this.embeddings.getConfig(companyId);
    const upToDate = cfg
      ? await this.prisma.knowledgeChunk.count({
          where: { companyId, embeddingModel: cfg.model },
        })
      : 0;
    return {
      configured: cfg !== null,
      // config apontando para chave deletada/incompatível: a UI avisa
      broken: cfg === null && Boolean(company?.embeddingKeyId),
      keyId: company?.embeddingKeyId ?? null,
      model: company?.embeddingModel ?? null,
      total,
      embedded,
      upToDate,
      reindexing: this.reindexing.has(companyId),
    };
  }

  /** Reembeda chunks pendentes (e invalida os de modelo divergente). */
  async reindex(companyId: string) {
    const cfg = await this.embeddings.getConfig(companyId);
    if (!cfg) {
      throw new BadRequestException(
        'Configure uma chave e um modelo de embeddings antes de reindexar',
      );
    }
    if (this.reindexing.has(companyId)) {
      return { started: false, reindexing: true };
    }
    this.reindexing.add(companyId);
    void this.reindexAll(companyId, cfg).finally(() =>
      this.reindexing.delete(companyId),
    );
    return { started: true, reindexing: true };
  }

  private async reindexAll(companyId: string, cfg: EmbeddingConfig) {
    try {
      // invalida embeddings de modelo divergente do atual
      await this.prisma.$executeRaw`
        UPDATE "KnowledgeChunk"
        SET "embedding" = NULL, "embeddingModel" = NULL
        WHERE "companyId" = ${companyId}
          AND "embeddingModel" IS NOT NULL
          AND "embeddingModel" <> ${cfg.model}
      `;
      const docs = await this.prisma.knowledgeDocument.findMany({
        where: { companyId, status: KnowledgeStatus.READY },
        select: { id: true },
      });
      for (const doc of docs) {
        await this.embedDocument(doc.id, cfg);
      }
    } catch (err) {
      this.logger.error(
        `reindex falhou para ${companyId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Embeda os chunks sem embedding de um documento. Best-effort: falha só
   * loga — o documento permanece READY com busca lexical.
   */
  private async embedDocument(documentId: string, config?: EmbeddingConfig) {
    try {
      const doc = await this.prisma.knowledgeDocument.findUnique({
        where: { id: documentId },
        select: { companyId: true },
      });
      if (!doc) return;
      const cfg = config ?? (await this.embeddings.getConfig(doc.companyId));
      if (!cfg) return;

      const chunks = await this.prisma.knowledgeChunk.findMany({
        where: { documentId, embeddingModel: null },
        orderBy: { index: 'asc' },
        select: { id: true, content: true },
      });
      if (chunks.length > 0) {
        const vectors = await this.embeddings.embed(
          cfg,
          chunks.map((c) => c.content),
        );
        for (let i = 0; i < chunks.length; i++) {
          await this.prisma.$executeRaw`
            UPDATE "KnowledgeChunk"
            SET "embedding" = ${JSON.stringify(vectors[i])}::vector,
                "embeddingModel" = ${cfg.model}
            WHERE "id" = ${chunks[i].id}
          `;
        }
      }
      const embedded = await this.prisma.knowledgeChunk.count({
        where: { documentId, embeddingModel: cfg.model },
      });
      await this.prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: { embeddedCount: embedded },
      });
    } catch (err) {
      this.logger.warn(
        `embedding do documento ${documentId} falhou (busca segue lexical): ${(err as Error).message}`,
      );
    }
  }

  // ---- privados -------------------------------------------------------------

  private async ensureAgent(companyId: string, agentId?: string) {
    if (!agentId) return;
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, companyId },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agente não encontrado');
  }

  private async process(
    documentId: string,
    file: { originalname: string; buffer: Buffer; mimetype: string },
  ) {
    try {
      const text = await this.extractText(file);
      await this.processText(documentId, text);
    } catch (err) {
      await this.markError(documentId, err as Error);
    }
  }

  private async processText(documentId: string, text: string) {
    try {
      const doc = await this.prisma.knowledgeDocument.findUniqueOrThrow({
        where: { id: documentId },
        select: { companyId: true },
      });
      const chunks = this.chunk(text);
      if (chunks.length === 0) {
        throw new BadRequestException('Nenhum texto extraído do documento');
      }
      await this.prisma.knowledgeChunk.createMany({
        data: chunks.map((content, index) => ({
          documentId,
          companyId: doc.companyId,
          index,
          content,
        })),
      });
      await this.prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: { status: KnowledgeStatus.READY, chunkCount: chunks.length },
      });
      // embeddings em background, best-effort (doc já está READY)
      void this.embedDocument(documentId);
    } catch (err) {
      await this.markError(documentId, err as Error);
    }
  }

  private async markError(documentId: string, err: Error) {
    this.logger.error(
      `Falha ao indexar documento ${documentId}: ${err.message}`,
    );
    await this.prisma.knowledgeDocument
      .update({
        where: { id: documentId },
        data: {
          status: KnowledgeStatus.ERROR,
          error: err.message.slice(0, 500),
        },
      })
      .catch(() => undefined);
  }

  /** Extração leve de texto de HTML (sem headless browser). */
  private htmlToText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/[ \t]{2,}/g, ' ');
  }

  private async extractText(file: {
    originalname: string;
    buffer: Buffer;
    mimetype: string;
  }): Promise<string> {
    const name = file.originalname.toLowerCase();
    if (file.mimetype === 'application/pdf' || name.endsWith('.pdf')) {
      const pdfParse = (await import('pdf-parse')) as unknown as {
        default: (buffer: Buffer) => Promise<{ text: string }>;
      };
      const parse = pdfParse.default ?? pdfParse;
      const result = await parse(file.buffer);
      return result.text;
    }
    if (name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value;
    }
    if (
      file.mimetype.startsWith('text/') ||
      /\.(txt|md|csv|json)$/.test(name)
    ) {
      return file.buffer.toString('utf-8');
    }
    throw new BadRequestException(
      'Formato não suportado. Envie PDF, DOCX, TXT, MD ou CSV.',
    );
  }

  private chunk(text: string): string[] {
    const clean = text
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!clean) return [];
    const chunks: string[] = [];
    let start = 0;
    while (start < clean.length) {
      let end = Math.min(start + CHUNK_SIZE, clean.length);
      if (end < clean.length) {
        // corta em fim de parágrafo/frase para não partir ideias ao meio
        const paragraph = clean.lastIndexOf('\n\n', end);
        const sentence = clean.lastIndexOf('. ', end);
        const cut = Math.max(paragraph, sentence);
        if (cut > start + CHUNK_SIZE / 2) end = cut + 1;
      }
      chunks.push(clean.slice(start, end).trim());
      if (end >= clean.length) break;
      start = end - CHUNK_OVERLAP;
    }
    return chunks.filter((c) => c.length > 0);
  }
}
