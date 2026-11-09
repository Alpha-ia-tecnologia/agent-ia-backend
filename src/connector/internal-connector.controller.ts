import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BridgeKeyGuard } from '../tools/guards/bridge-key.guard';
import {
  ConnectorOp,
  ConnectorRegistryService,
} from './connector-registry.service';

/**
 * Consumido pelo bridge via as ferramentas `arquivos_locais_*`. companyId
 * viaja na query (fixado pelo aao-api ao montar a tool); o modelo controla o
 * body. Erros viram { erro } com HTTP 200 para o agente ler e explicar.
 */
@Controller('internal/connector')
@UseGuards(BridgeKeyGuard)
export class InternalConnectorController {
  constructor(private readonly registry: ConnectorRegistryService) {}

  @Post('devices')
  @Public()
  devices(@Query('companyId') companyId: string) {
    const online = this.registry.listOnline(companyId);
    if (!online.length) {
      return {
        erro: 'Nenhum computador conectado. Peça ao usuário para iniciar o aplicativo conector.',
      };
    }
    return {
      dispositivos: online.map((d) => ({
        nome: d.name,
        pastas: d.folders.map((f) => ({
          caminho: f.path,
          somente_leitura: f.readOnly,
        })),
      })),
    };
  }

  @Post('list')
  @Public()
  list(
    @Query('companyId') companyId: string,
    @Body() body: { caminho?: string; dispositivo?: string },
  ) {
    return this.call(
      companyId,
      'list',
      { caminho: str(body?.caminho) },
      str(body?.dispositivo),
    );
  }

  @Post('read')
  @Public()
  read(
    @Query('companyId') companyId: string,
    @Body() body: { caminho?: string; dispositivo?: string },
  ) {
    return this.call(
      companyId,
      'read',
      { caminho: str(body?.caminho) },
      str(body?.dispositivo),
    );
  }

  @Post('search')
  @Public()
  search(
    @Query('companyId') companyId: string,
    @Body() body: { termo?: string; caminho?: string; dispositivo?: string },
  ) {
    return this.call(
      companyId,
      'search',
      { termo: str(body?.termo), caminho: str(body?.caminho) },
      str(body?.dispositivo),
    );
  }

  @Post('write')
  @Public()
  write(
    @Query('companyId') companyId: string,
    @Body() body: { caminho?: string; conteudo?: string; dispositivo?: string },
  ) {
    return this.call(
      companyId,
      'write',
      { caminho: str(body?.caminho), conteudo: str(body?.conteudo) },
      str(body?.dispositivo),
    );
  }

  private async call(
    companyId: string,
    op: ConnectorOp,
    params: Record<string, unknown>,
    dispositivo?: string,
  ) {
    if (!companyId) return { erro: 'companyId ausente' };
    if (!this.registry.isOnline(companyId)) {
      return {
        erro: 'O conector local está offline. Peça ao usuário para iniciar o aplicativo conector no computador dele.',
      };
    }
    try {
      return await this.registry.call(companyId, op, params, dispositivo);
    } catch (err) {
      return {
        erro: `Falha na operação nos arquivos locais: ${(err as Error).message}`,
      };
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
