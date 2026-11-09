import { Injectable } from '@nestjs/common';
import { cellText } from './dataset-import';
import { PrismaService } from '../prisma/prisma.service';
import { ChartService, ChartSpec } from './chart.service';
import { DatasetFilter, DatasetQueryService } from './dataset-query.service';

export interface ForecastRequest {
  base: string;
  coluna_data: string;
  coluna_valor: string;
  funcao?: 'soma' | 'media';
  filtros?: DatasetFilter[];
  granularidade?: 'dia' | 'mes';
  horizonte?: number; // períodos à frente
  titulo?: string;
}

interface ForecastResult {
  metodo: string;
  mae: number;
  historico: { periodo: string; valor: number }[];
  previsao: { periodo: string; valor: number; min: number; max: number }[];
}

/**
 * Previsão DETERMINÍSTICA sobre séries temporais dos datasets: três métodos
 * simples (média móvel, regressão linear, sazonal ingênuo), escolhidos por
 * backtest (menor MAE nos últimos períodos), com banda de ~80% de confiança
 * derivada dos resíduos. Sem LLM em nenhum cálculo.
 */
@Injectable()
export class ForecastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: DatasetQueryService,
    private readonly charts: ChartService,
  ) {}

  async forecast(
    companyId: string,
    req: ForecastRequest,
  ): Promise<{ erro?: string; result?: ForecastResult; spec?: ChartSpec }> {
    if (!req.base || !req.coluna_data || !req.coluna_valor) {
      return { erro: 'Informe base, coluna_data e coluna_valor' };
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

    const result = await this.query.query(
      dataset.id,
      dataset.columns.map((c) => ({ name: c.name, type: c.type })),
      {
        filtros: req.filtros,
        agrupar_por: [req.coluna_data],
        agregacoes: [
          { funcao: req.funcao ?? 'soma', coluna: req.coluna_valor },
        ],
        ordenar_por: req.coluna_data,
        ordem: 'asc',
        limite: 500,
      },
    );
    if (result.erro) return { erro: result.erro };

    const dateKey = dataset.columns.find(
      (c) => c.name.toLowerCase() === req.coluna_data.toLowerCase(),
    )!.name;
    const valueAlias = `${req.funcao ?? 'soma'}_${req.coluna_valor}`;

    // agrega por período (dia ou mês)
    const gran = req.granularidade ?? 'mes';
    const byPeriod = new Map<string, number>();
    for (const row of result.linhas ?? []) {
      const raw = cellText(row[dateKey]);
      const period = gran === 'mes' ? raw.slice(0, 7) : raw.slice(0, 10);
      if (!period) continue;
      const value = Number(row[valueAlias] ?? 0);
      byPeriod.set(period, (byPeriod.get(period) ?? 0) + value);
    }
    const periods = [...byPeriod.keys()].sort();
    const values = periods.map((p) => byPeriod.get(p)!);
    if (values.length < 4) {
      return {
        erro: `Série muito curta para prever (${values.length} períodos; mínimo 4). Verifique coluna_data/granularidade.`,
      };
    }

    const horizon = Math.min(Math.max(req.horizonte ?? 6, 1), 24);
    const season = gran === 'mes' ? 12 : 7;

    // ---- métodos
    const movingAvg = (train: number[]): ((step: number) => number) => {
      const window = Math.min(3, train.length);
      const avg = train.slice(-window).reduce((a, b) => a + b, 0) / window;
      return () => avg; // média móvel: igual para qualquer passo
    };
    const linear = (train: number[]) => {
      const n = train.length;
      const xm = (n - 1) / 2;
      const ym = train.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        num += (i - xm) * (train[i] - ym);
        den += (i - xm) ** 2;
      }
      const b = den ? num / den : 0;
      const a = ym - b * xm;
      return (step: number) => a + b * (train.length - 1 + step);
    };
    const seasonalNaive = (train: number[]) => (step: number) => {
      const idx = train.length - season + ((step - 1) % season);
      return idx >= 0 ? train[idx] : train[train.length - 1];
    };

    const methods: {
      nome: string;
      fit: (t: number[]) => (s: number) => number;
      ok: boolean;
    }[] = [
      { nome: 'média móvel', fit: movingAvg, ok: true },
      { nome: 'regressão linear', fit: linear, ok: values.length >= 5 },
      { nome: 'sazonal', fit: seasonalNaive, ok: values.length >= season + 2 },
    ];

    // ---- backtest: prevê os últimos h períodos conhecidos
    const hTest = Math.max(2, Math.min(Math.floor(values.length * 0.25), 6));
    const train = values.slice(0, -hTest);
    const test = values.slice(-hTest);
    let best = methods[0];
    let bestMae = Infinity;
    for (const method of methods) {
      if (!method.ok || train.length < 3) continue;
      const predict = method.fit(train);
      const mae =
        test.reduce((acc, y, i) => acc + Math.abs(y - predict(i + 1)), 0) /
        test.length;
      if (mae < bestMae) {
        bestMae = mae;
        best = method;
      }
    }

    // ---- previsão final com todo o histórico + banda pelos resíduos do backtest
    const predictFull = best.fit(values);
    const sigma = bestMae * 1.25; // MAE→σ aproximado; banda ~80% = ±1.28σ
    const nextPeriod = (p: string, step: number) => {
      if (gran === 'mes') {
        const [y, m] = p.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + step, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      const d = new Date(`${p}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + step);
      return d.toISOString().slice(0, 10);
    };
    const last = periods[periods.length - 1];
    const previsao = Array.from({ length: horizon }, (_, i) => {
      const value = predictFull(i + 1);
      const spread = 1.28 * sigma * Math.sqrt(1 + i * 0.15); // incerteza cresce
      return {
        periodo: nextPeriod(last, i + 1),
        valor: Math.round(value * 100) / 100,
        min: Math.round((value - spread) * 100) / 100,
        max: Math.round((value + spread) * 100) / 100,
      };
    });

    const forecastResult: ForecastResult = {
      metodo: best.nome,
      mae: Math.round(bestMae * 100) / 100,
      historico: periods.map((p, i) => ({ periodo: p, valor: values[i] })),
      previsao,
    };

    // ---- gráfico: histórico sólido + previsão tracejada + banda
    const categorias = [...periods, ...previsao.map((f) => f.periodo)];
    const nHist = periods.length;
    const spec: ChartSpec = {
      tipo: 'linha',
      titulo:
        req.titulo ??
        `Previsão de ${req.coluna_valor} (${best.nome}, ${horizon} períodos)`,
      eixoX: dateKey,
      categorias,
      series: [
        {
          nome: 'Histórico',
          valores: [...values, ...Array<null>(horizon).fill(null)],
        },
        {
          nome: 'Previsão',
          valores: [
            ...Array<null>(nHist - 1).fill(null),
            values[nHist - 1], // emenda visual com o histórico
            ...previsao.map((f) => f.valor),
          ],
          tracejada: true,
        },
      ],
      banda: {
        min: [...Array<null>(nHist).fill(null), ...previsao.map((f) => f.min)],
        max: [...Array<null>(nHist).fill(null), ...previsao.map((f) => f.max)],
      },
      geradoEm: new Date().toISOString(),
      base: dataset.name,
    };

    return { result: forecastResult, spec };
  }
}
