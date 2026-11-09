import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import { KnowledgeService } from './knowledge.service';

/**
 * Consumido pelo bridge via a ferramenta dinâmica `buscar_conhecimento`.
 * companyId/agentId viajam na query string (definidos pelo aao-api ao montar
 * a ferramenta); o modelo só controla o corpo { query }.
 */
@Controller('internal/knowledge')
export class InternalKnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  @Post('search')
  @Public()
  @UseGuards(BridgeKeyGuard)
  async search(
    @Query('companyId') companyId: string,
    @Query('agentId') agentId: string | undefined,
    @Body('query') query: string,
  ) {
    const hits = await this.service.search(
      companyId,
      String(query ?? ''),
      agentId || undefined,
    );
    if (hits.length === 0) {
      return {
        found: 0,
        message:
          'Nenhum trecho relevante encontrado na base de conhecimento para essa busca.',
      };
    }
    return {
      found: hits.length,
      results: hits.map((h) => ({
        documento: h.documentTitle,
        trecho: h.content,
      })),
    };
  }
}
