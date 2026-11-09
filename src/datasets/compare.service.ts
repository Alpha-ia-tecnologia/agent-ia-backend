import { Injectable } from '@nestjs/common';
import { cellText } from './dataset-import';
import { PrismaService } from '../prisma/prisma.service';
import { ChartSpec } from './chart.service';
import {
  DatasetAggregation,
  DatasetFilter,
  DatasetQueryService,
} from './dataset-query.service';

interface CompareSide {
  coluna: string;
  funcao?: DatasetAggregation['funcao'];
  nome?: string;
  filtros?: DatasetFilter[];
}

export interface CompareRequest {
  base: string;
  dimensao: string; // coluna de agrupamento (setor, mês, produto…)
  valor_a: CompareSide; // ex.: realizado
  valor_b: CompareSide; // ex.: orçado (referência)
  filtros?: DatasetFilter[]; // filtros comuns aos dois lados
  limite?: number;
  titulo?: string;
}

export interface CompareRow {
  categoria: string;
  a: number;
  b: number;
  delta: number;
  delta_pct: number | null;
}

/**
 * Comparativo determinístico (realizado × orçado, período × período…):
 * dois recortes calculados pelo motor, juntados por categoria, com delta
 * absoluto E percentual (regra FP&A), ordenados pelos maiores desvios.
 */
@Injectable()
export class CompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: DatasetQueryService,
  ) {}

  async compare(
    companyId: string,
    req: CompareRequest,
  ): Promise<{
    erro?: string;
    rows?: CompareRow[];
    spec?: ChartSpec;
    nomes?: [string, string];
  }> {
    if (
      !req.base ||
      !req.dimensao ||
      !req.valor_a?.coluna ||
      !req.valor_b?.coluna
    ) {
      return {
        erro: 'Informe base, dimensao, valor_a.coluna e valor_b.coluna',
      };
    }
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
    if (!dataset) return { erro: `Base "${req.base}" não encontrada` };
    const columns = dataset.columns.map((c) => ({
      name: c.name,
      type: c.type,
    }));

    const side = async (s: CompareSide) => {
      const funcao = s.funcao ?? 'soma';
      const result = await this.query.query(dataset.id, columns, {
        filtros: [...(req.filtros ?? []), ...(s.filtros ?? [])],
        agrupar_por: [req.dimensao],
        agregacoes: [{ funcao, coluna: s.coluna }],
        ordenar_por: req.dimensao,
        ordem: 'asc',
        limite: 200,
      });
      if (result.erro) return { erro: result.erro };
      const dimKey = columns.find(
        (c) => c.name.toLowerCase() === req.dimensao.toLowerCase(),
      )!.name;
      const alias = `${funcao}_${s.coluna}`;
      const map = new Map<string, number>();
      for (const row of result.linhas ?? []) {
        map.set(cellText(row[dimKey]), Number(row[alias] ?? 0));
      }
      return { map };
    };

    const [a, b] = await Promise.all([side(req.valor_a), side(req.valor_b)]);
    if ('erro' in a && a.erro) return { erro: `valor_a: ${a.erro}` };
    if ('erro' in b && b.erro) return { erro: `valor_b: ${b.erro}` };
    const mapA = (a as { map: Map<string, number> }).map;
    const mapB = (b as { map: Map<string, number> }).map;

    const categorias = [...new Set([...mapA.keys(), ...mapB.keys()])];
    if (!categorias.length) return { erro: 'A comparação não retornou dados' };

    const rows: CompareRow[] = categorias
      .map((categoria) => {
        const va = mapA.get(categoria) ?? 0;
        const vb = mapB.get(categoria) ?? 0;
        return {
          categoria,
          a: va,
          b: vb,
          delta: Math.round((va - vb) * 100) / 100,
          delta_pct:
            vb !== 0
              ? Math.round(((va - vb) / Math.abs(vb)) * 1000) / 10
              : null,
        };
      })
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, Math.min(req.limite ?? 20, 50));

    const nomeA = req.valor_a.nome ?? req.valor_a.coluna;
    const nomeB = req.valor_b.nome ?? req.valor_b.coluna;
    const spec: ChartSpec = {
      tipo: 'barra',
      titulo: req.titulo ?? `${nomeA} × ${nomeB} por ${req.dimensao}`,
      eixoX: req.dimensao,
      categorias: rows.map((r) => r.categoria),
      series: [
        { nome: nomeA, valores: rows.map((r) => r.a) },
        { nome: nomeB, valores: rows.map((r) => r.b) },
      ],
      geradoEm: new Date().toISOString(),
      base: dataset.name,
    };
    return { rows, spec, nomes: [nomeA, nomeB] };
  }
}
