import { Injectable } from '@nestjs/common';
import { cellText } from './dataset-import';
import { PrismaService } from '../prisma/prisma.service';
import {
  DatasetAggregation,
  DatasetFilter,
  DatasetQueryService,
} from './dataset-query.service';

export interface ChartRequest {
  base: string;
  tipo?: 'linha' | 'barra' | 'area' | 'pizza';
  titulo?: string;
  eixo_x: string;
  series: {
    coluna: string;
    funcao?: DatasetAggregation['funcao'];
    nome?: string;
  }[];
  filtros?: DatasetFilter[];
  limite?: number;
}

export interface ChartSpec {
  tipo: 'linha' | 'barra' | 'area' | 'pizza';
  titulo: string;
  eixoX: string;
  categorias: string[];
  series: { nome: string; valores: (number | null)[]; tracejada?: boolean }[];
  /** faixa de confiança (previsões): arrays alinhados a `categorias` */
  banda?: { min: (number | null)[]; max: (number | null)[] };
  geradoEm: string;
  /** nome da base de origem; vazio quando o gráfico veio da análise do agente */
  base: string;
}

/**
 * Gráfico "livre": o agente calcula os números na sua própria análise e passa
 * os pontos prontos (sem base de dados). Vale para qualquer conversa.
 */
export interface InlineChartRequest {
  tipo?: 'linha' | 'barra' | 'area' | 'pizza';
  titulo?: string;
  eixo_x?: string;
  categorias: string[];
  series: { nome?: string; valores: (number | null)[]; tracejada?: boolean }[];
}

/**
 * Constrói gráficos a partir do motor determinístico de datasets: o agente
 * descreve o gráfico, o servidor CALCULA os pontos. A spec fica pendente na
 * conversa e é anexada à resposta final (Message.metadata.charts).
 */
@Injectable()
export class ChartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: DatasetQueryService,
  ) {}

  async build(
    companyId: string,
    req: ChartRequest,
  ): Promise<{ erro?: string; spec?: ChartSpec }> {
    if (!req.base || !req.eixo_x || !req.series?.length) {
      return { erro: 'Informe base, eixo_x e ao menos uma série' };
    }
    if (req.series.length > 5)
      return { erro: 'Máximo de 5 séries por gráfico' };

    const dataset = await this.prisma.dataset.findFirst({
      where: {
        companyId,
        OR: [
          { id: req.base },
          { name: { equals: req.base, mode: 'insensitive' } },
        ],
      },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
    if (!dataset) {
      return { erro: `Base "${req.base}" não encontrada — use dados_listar` };
    }

    const aggs: DatasetAggregation[] = req.series.map((s) => ({
      funcao: s.funcao ?? 'soma',
      coluna: s.coluna,
    }));
    const result = await this.query.query(
      dataset.id,
      dataset.columns.map((c) => ({ name: c.name, type: c.type })),
      {
        filtros: req.filtros,
        agrupar_por: [req.eixo_x],
        agregacoes: aggs,
        ordenar_por: req.eixo_x,
        ordem: 'asc',
        limite: Math.min(req.limite ?? 50, 100),
      },
    );
    if (result.erro) return { erro: result.erro };
    const rows = result.linhas ?? [];
    if (!rows.length)
      return { erro: 'A consulta não retornou dados para o gráfico' };

    const xKey = dataset.columns.find(
      (c) => c.name.toLowerCase() === req.eixo_x.toLowerCase(),
    )!.name;
    const categorias = rows.map((r) => cellText(r[xKey]));
    const series = req.series.map((s, i) => {
      const alias = `${aggs[i].funcao}_${s.coluna}`;
      return {
        nome: s.nome ?? s.coluna,
        valores: rows.map((r) => {
          const v = r[alias];
          return typeof v === 'number' ? v : v == null ? null : Number(v);
        }),
      };
    });

    const spec: ChartSpec = {
      tipo: req.tipo ?? 'barra',
      titulo:
        req.titulo ?? `${series.map((s) => s.nome).join(', ')} por ${xKey}`,
      eixoX: xKey,
      categorias,
      series,
      geradoEm: new Date().toISOString(),
      base: dataset.name,
    };
    return { spec };
  }

  /**
   * Monta a spec a partir dos pontos que o próprio agente forneceu (sem base).
   * Puro: não toca no banco — apenas valida e normaliza os arrays.
   */
  buildInline(req: InlineChartRequest): { erro?: string; spec?: ChartSpec } {
    const categorias = (req.categorias ?? []).map((c) => String(c ?? ''));
    if (!categorias.length)
      return { erro: 'Informe categorias (rótulos do eixo X)' };
    if (categorias.length > 200)
      return { erro: 'Máximo de 200 pontos por gráfico' };
    if (!req.series?.length) return { erro: 'Informe ao menos uma série' };
    if (req.series.length > 5)
      return { erro: 'Máximo de 5 séries por gráfico' };

    const toNum = (v: unknown): number | null => {
      if (v == null || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const series = req.series.map((s, i) => {
      // alinha 1-a-1 com categorias: completa com null, corta o excedente
      const valores = categorias.map((_, j) => toNum(s.valores?.[j]));
      return {
        nome: s.nome?.trim() || `Série ${i + 1}`,
        valores,
        ...(s.tracejada ? { tracejada: true } : {}),
      };
    });

    const spec: ChartSpec = {
      tipo: req.tipo ?? 'barra',
      titulo: req.titulo?.trim() || series.map((s) => s.nome).join(', '),
      eixoX: req.eixo_x?.trim() || '',
      categorias,
      series,
      geradoEm: new Date().toISOString(),
      base: '',
    };
    return { spec };
  }

  /** Pendura a spec na conversa; consumeBridge anexa à resposta final. */
  async attachPending(conversationId: string, spec: ChartSpec): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    if (!conv) return;
    const meta = (conv.metadata ?? {}) as Record<string, unknown>;
    const pending = Array.isArray(meta.pendingCharts) ? meta.pendingCharts : [];
    if (pending.length >= 4) pending.shift(); // no máximo 4 gráficos por resposta
    pending.push(spec);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: { ...meta, pendingCharts: pending },
      },
    });
  }

  /** Consome (e limpa) os gráficos pendentes da conversa. */
  async drainPending(conversationId: string): Promise<ChartSpec[]> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const meta = (conv?.metadata ?? {}) as Record<string, unknown>;
    const pending = Array.isArray(meta.pendingCharts)
      ? (meta.pendingCharts as unknown as ChartSpec[])
      : [];
    if (pending.length) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          metadata: { ...meta, pendingCharts: [] },
        },
      });
    }
    return pending;
  }
}
