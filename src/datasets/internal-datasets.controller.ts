import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { ChartService } from './chart.service';
import { CompareService } from './compare.service';
import type { CompareRequest } from './compare.service';
import { ForecastService } from './forecast.service';
import type { ForecastRequest } from './forecast.service';
import type { ChartRequest, InlineChartRequest } from './chart.service';
import { ReportService } from './report.service';
import { DatasetQuery, DatasetQueryService } from './dataset-query.service';

/**
 * Ferramentas de dados estruturados para os agentes (via bridge).
 * Só leitura e agregação: agentes nunca alteram nem excluem dados.
 * Erros de uso viram { erro } legível (HTTP 200) para o modelo se corrigir.
 */
@Controller('internal/datasets')
@UseGuards(BridgeKeyGuard)
export class InternalDatasetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: DatasetQueryService,
    private readonly charts: ChartService,
    private readonly forecastService: ForecastService,
    private readonly compareService: CompareService,
    private readonly reports: ReportService,
  ) {}

  @Post('comparar')
  @Public()
  async comparar(
    @Query('companyId') companyId: string,
    @Query('conversationId') conversationId: string,
    @Body() body: CompareRequest,
  ) {
    const { erro, rows, spec, nomes } = await this.compareService.compare(
      companyId,
      body,
    );
    if (erro || !rows || !spec || !nomes)
      return { erro: erro ?? 'falha na comparação' };
    if (conversationId) await this.charts.attachPending(conversationId, spec);
    const totalA = rows.reduce((acc, r) => acc + r.a, 0);
    const totalB = rows.reduce((acc, r) => acc + r.b, 0);
    return {
      ok: true,
      grafico_anexado: true,
      legenda: { a: nomes[0], b: nomes[1] },
      total: {
        [nomes[0]]: Math.round(totalA * 100) / 100,
        [nomes[1]]: Math.round(totalB * 100) / 100,
        delta: Math.round((totalA - totalB) * 100) / 100,
        delta_pct:
          totalB !== 0
            ? Math.round(((totalA - totalB) / Math.abs(totalB)) * 1000) / 10
            : null,
      },
      // já ordenado pelos MAIORES desvios absolutos
      maiores_desvios: rows.slice(0, 10),
      instrucao:
        'Cite os desvios sempre em valor absoluto E percentual. Destaque os 2-3 maiores e proponha próximos passos. O gráfico comparativo será exibido junto à resposta.',
    };
  }

  @Post('prever')
  @Public()
  async prever(
    @Query('companyId') companyId: string,
    @Query('conversationId') conversationId: string,
    @Body() body: ForecastRequest,
  ) {
    const { erro, result, spec } = await this.forecastService.forecast(
      companyId,
      body,
    );
    if (erro || !result || !spec) return { erro: erro ?? 'falha na previsão' };
    if (conversationId) await this.charts.attachPending(conversationId, spec);
    const ultimoReal = result.historico[result.historico.length - 1];
    const fimHorizonte = result.previsao[result.previsao.length - 1];
    return {
      ok: true,
      grafico_anexado: true,
      metodo: result.metodo,
      erro_medio_backtest: result.mae,
      ultimo_periodo_real: ultimoReal,
      previsao: result.previsao.map((f) => ({
        periodo: f.periodo,
        valor: f.valor,
        faixa: [f.min, f.max],
      })),
      variacao_prevista_pct:
        ultimoReal.valor !== 0
          ? Math.round(
              ((fimHorizonte.valor - ultimoReal.valor) /
                Math.abs(ultimoReal.valor)) *
                1000,
            ) / 10
          : null,
      instrucao:
        'Apresente a previsão como FAIXA (não como certeza), cite o método usado e ressalte que é uma projeção estatística simples baseada no histórico. O gráfico com a banda de confiança será exibido junto à resposta.',
    };
  }

  @Post('grafico')
  @Public()
  async grafico(
    @Query('companyId') companyId: string,
    @Query('conversationId') conversationId: string,
    @Body() body: ChartRequest,
  ) {
    const { erro, spec } = await this.charts.build(companyId, body);
    if (erro || !spec) return { erro: erro ?? 'falha ao gerar o gráfico' };
    if (conversationId) {
      await this.charts.attachPending(conversationId, spec);
    }
    // resumo compacto p/ o agente narrar os números (o gráfico em si vai
    // anexado à resposta final automaticamente)
    return {
      ok: true,
      grafico_anexado: true,
      titulo: spec.titulo,
      resumo: {
        eixo_x: spec.eixoX,
        pontos: spec.categorias.length,
        series: spec.series.map((serie) => ({
          nome: serie.nome,
          primeiro: serie.valores[0],
          ultimo: serie.valores[serie.valores.length - 1],
          total: serie.valores.reduce((a, b) => (a ?? 0) + (b ?? 0), 0),
        })),
      },
      instrucao:
        'O gráfico interativo será exibido junto com a sua resposta — não descreva o gráfico em texto, apenas os insights.',
    };
  }

  /**
   * Gráfico "livre": o agente fornece os pontos que ele mesmo calculou na
   * análise (não depende de base importada). Aparece junto com a resposta.
   */
  @Post('grafico-livre')
  @Public()
  async graficoLivre(
    @Query('conversationId') conversationId: string,
    @Body() body: InlineChartRequest,
  ) {
    const { erro, spec } = this.charts.buildInline(body);
    if (erro || !spec) return { erro: erro ?? 'falha ao gerar o gráfico' };
    if (conversationId) await this.charts.attachPending(conversationId, spec);
    return {
      ok: true,
      grafico_anexado: true,
      titulo: spec.titulo,
      pontos: spec.categorias.length,
      series: spec.series.map((s) => s.nome),
      instrucao:
        'O gráfico será exibido junto com a sua resposta — não descreva o gráfico em texto, apenas comente os insights.',
    };
  }

  /**
   * Relatório em PDF entregue na conversa (gerado no navegador do usuário).
   * O agente manda o conteúdo em Markdown; nada é salvo em disco.
   */
  @Post('relatorio-pdf')
  @Public()
  async relatorioPdf(
    @Query('conversationId') conversationId: string,
    @Body() body: { titulo?: string; conteudo_markdown?: string },
  ) {
    const { erro, spec } = this.reports.build(body);
    if (erro || !spec) return { erro: erro ?? 'falha ao montar o relatório' };
    if (conversationId) await this.reports.attachPending(conversationId, spec);
    return {
      ok: true,
      relatorio_anexado: true,
      titulo: spec.titulo,
      instrucao:
        'O relatório aparecerá na conversa com um botão "Baixar PDF" para o usuário — não repita o conteúdo em texto, apenas confirme que o relatório está pronto para download.',
    };
  }

  private async resolveDataset(companyId: string, ref: string) {
    if (!ref) return null;
    const byId = await this.prisma.dataset.findFirst({
      where: { id: ref, companyId },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
    if (byId) return byId;
    return this.prisma.dataset.findFirst({
      where: { companyId, name: { equals: ref, mode: 'insensitive' } },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  @Get('listar')
  @Public()
  async listar(@Query('companyId') companyId: string) {
    const datasets = await this.prisma.dataset.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
    if (!datasets.length) {
      return {
        erro: 'Nenhuma base de dados cadastrada. Peça ao usuário para importar uma planilha na página Dados.',
      };
    }
    return {
      bases: datasets.map((d) => ({
        nome: d.name,
        descricao: d.description || undefined,
        linhas: d.rowCount,
        qualidade: d.quality === 'OK' ? 'ok' : 'com ressalvas',
        avisos: (d.qualityNotes as string[])?.length
          ? d.qualityNotes
          : undefined,
        atualizado_em: d.updatedAt.toISOString().slice(0, 10),
        colunas: d.columns.map((c) => ({
          nome: c.name,
          tipo: c.type,
          descricao: c.description || undefined,
        })),
      })),
    };
  }

  @Post('amostra')
  @Public()
  async amostra(
    @Query('companyId') companyId: string,
    @Body() body: { base: string; linhas?: number },
  ) {
    const dataset = await this.resolveDataset(companyId, body.base ?? '');
    if (!dataset) {
      return {
        erro: `Base "${body.base}" não encontrada. Use dados_listar para ver as bases disponíveis.`,
      };
    }
    const take = Math.min(Math.max(body.linhas ?? 5, 1), 20);
    const rows = await this.prisma.datasetRow.findMany({
      where: { datasetId: dataset.id },
      orderBy: { rowIndex: 'asc' },
      take,
      select: { data: true },
    });
    return {
      base: dataset.name,
      total_de_linhas: dataset.rowCount,
      amostra: rows.map((r) => r.data),
    };
  }

  @Post('consultar')
  @Public()
  async consultar(
    @Query('companyId') companyId: string,
    @Body() body: { base: string } & DatasetQuery,
  ) {
    const dataset = await this.resolveDataset(companyId, body.base ?? '');
    if (!dataset) {
      return {
        erro: `Base "${body.base}" não encontrada. Use dados_listar para ver as bases disponíveis.`,
      };
    }
    const result = await this.query.query(
      dataset.id,
      dataset.columns.map((c) => ({ name: c.name, type: c.type })),
      body,
    );
    if (result.erro) return result;
    return {
      base: dataset.name,
      resultado: result.linhas,
      observacao:
        dataset.quality === 'WITH_ISSUES'
          ? 'Atenção: esta base foi importada com ressalvas de qualidade; considere isso na análise.'
          : undefined,
    };
  }
}
