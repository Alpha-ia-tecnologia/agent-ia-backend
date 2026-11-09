import {
  Body,
  Controller,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ExecuteToolDto } from './dto/tool.dto';
import { BridgeKeyGuard } from './guards/bridge-key.guard';
import { ToolExecutorService } from './tool-executor.service';
import { ToolsService } from './tools.service';

/** Endpoint interno consumido pelo bridge FastAPI durante o function calling. */
@Controller('internal/tools')
export class InternalToolsController {
  constructor(
    private readonly tools: ToolsService,
    private readonly executor: ToolExecutorService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('execute')
  @Public()
  @UseGuards(BridgeKeyGuard)
  async execute(@Body() dto: ExecuteToolDto) {
    const tool = await this.tools.findByName(dto.companyId, dto.toolName);
    if (!tool) {
      throw new NotFoundException(
        `Ferramenta "${dto.toolName}" não encontrada ou inativa`,
      );
    }

    const result = await this.executor.execute(tool, dto.args ?? {});

    await this.prisma.orchestrationEvent
      .create({
        data: {
          companyId: dto.companyId,
          type: 'tool_executed',
          payload: {
            toolName: tool.name,
            args: dto.args ?? {},
            ok: result.ok,
            status: result.status ?? null,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return result;
  }
}
