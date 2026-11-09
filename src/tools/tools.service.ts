import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomTool, Prisma } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateToolDto, UpdateToolDto } from './dto/tool.dto';
import { validateParamsSchema } from './params-schema.validator';
import { ToolExecutorService } from './tool-executor.service';

/** Formato de tool enviado ao bridge no payload do chat. */
export interface BridgeTool {
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  params_schema: Record<string, unknown>;
  timeout_ms: number;
}

@Injectable()
export class ToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly executor: ToolExecutorService,
  ) {}

  async findAll(companyId: string) {
    const tools = await this.prisma.customTool.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
    });
    return tools.map((t) => this.toMasked(t));
  }

  async create(companyId: string, dto: CreateToolDto) {
    validateParamsSchema(dto.paramsSchema);
    await this.ensureUniqueName(companyId, dto.name);
    const enc =
      dto.headers && Object.keys(dto.headers).length
        ? this.crypto.encrypt(JSON.stringify(dto.headers))
        : null;
    const tool = await this.prisma.customTool.create({
      data: {
        companyId,
        name: dto.name,
        displayName: dto.displayName,
        description: dto.description,
        method: dto.method,
        url: dto.url,
        encryptedHeaders: enc?.encrypted ?? null,
        headersIv: enc?.iv ?? null,
        headersAuthTag: enc?.authTag ?? null,
        paramsSchema: dto.paramsSchema as Prisma.InputJsonValue,
        timeoutMs: dto.timeoutMs ?? 15000,
        isActive: dto.isActive ?? true,
      },
    });
    return this.toMasked(tool);
  }

  async update(companyId: string, id: string, dto: UpdateToolDto) {
    const existing = await this.getOwned(companyId, id);
    if (dto.paramsSchema !== undefined) validateParamsSchema(dto.paramsSchema);
    if (dto.name && dto.name !== existing.name) {
      await this.ensureUniqueName(companyId, dto.name);
    }

    const data: Prisma.CustomToolUpdateInput = {
      name: dto.name,
      displayName: dto.displayName,
      description: dto.description,
      method: dto.method,
      url: dto.url,
      paramsSchema: dto.paramsSchema as Prisma.InputJsonValue | undefined,
      timeoutMs: dto.timeoutMs,
      isActive: dto.isActive,
    };
    if (dto.headers !== undefined) {
      // Merge: valor vazio mantém o valor já salvo; chave ausente é removida.
      const current = this.executor.decryptHeaders(existing);
      const merged: Record<string, string> = {};
      for (const [k, v] of Object.entries(dto.headers)) {
        const kept = v === '' ? current[k] : v;
        if (kept) merged[k] = kept;
      }
      const enc = Object.keys(merged).length
        ? this.crypto.encrypt(JSON.stringify(merged))
        : null;
      data.encryptedHeaders = enc?.encrypted ?? null;
      data.headersIv = enc?.iv ?? null;
      data.headersAuthTag = enc?.authTag ?? null;
    }

    const tool = await this.prisma.customTool.update({ where: { id }, data });
    return this.toMasked(tool);
  }

  async remove(companyId: string, id: string) {
    await this.getOwned(companyId, id);
    await this.prisma.customTool.delete({ where: { id } });
    return { deleted: true };
  }

  async test(companyId: string, id: string, args?: Record<string, unknown>) {
    const tool = await this.getOwned(companyId, id);
    return this.executor.execute(tool, args ?? {});
  }

  async getOwned(companyId: string, id: string): Promise<CustomTool> {
    const tool = await this.prisma.customTool.findFirst({
      where: { id, companyId },
    });
    if (!tool) throw new NotFoundException('Ferramenta não encontrada');
    return tool;
  }

  findByName(companyId: string, name: string) {
    return this.prisma.customTool.findFirst({
      where: { companyId, name, isActive: true },
    });
  }

  // ---- Vínculo agente <-> tools -------------------------------------------

  async getAgentTools(companyId: string, agentId: string) {
    await this.ensureAgent(companyId, agentId);
    const rows = await this.prisma.agentTool.findMany({
      where: { agentId },
      include: { tool: true },
    });
    return rows.map((r) => this.toMasked(r.tool));
  }

  async setAgentTools(companyId: string, agentId: string, toolIds: string[]) {
    await this.ensureAgent(companyId, agentId);
    const unique = [...new Set(toolIds)];
    const tools = await this.prisma.customTool.findMany({
      where: { id: { in: unique }, companyId },
      select: { id: true },
    });
    if (tools.length !== unique.length) {
      throw new NotFoundException('Ferramenta não encontrada');
    }
    await this.prisma.$transaction([
      this.prisma.agentTool.deleteMany({ where: { agentId } }),
      this.prisma.agentTool.createMany({
        data: unique.map((toolId) => ({ agentId, toolId })),
      }),
    ]);
    return { toolIds: unique };
  }

  /** Tools ativas do agente no formato esperado pelo bridge (headers em claro). */
  async getBridgeToolsForAgent(agentId: string): Promise<BridgeTool[]> {
    const rows = await this.prisma.agentTool.findMany({
      where: { agentId, tool: { isActive: true } },
      include: { tool: true },
    });
    return rows.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      method: tool.method,
      url: tool.url,
      headers: this.executor.decryptHeaders(tool),
      params_schema: (tool.paramsSchema ?? {}) as Record<string, unknown>,
      timeout_ms: tool.timeoutMs,
    }));
  }

  // ---- privados -------------------------------------------------------------

  private async ensureAgent(companyId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, companyId },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agente não encontrado');
  }

  private async ensureUniqueName(companyId: string, name: string) {
    const existing = await this.prisma.customTool.findFirst({
      where: { companyId, name },
    });
    if (existing) {
      throw new ConflictException(
        `Já existe uma ferramenta com o nome "${name}" nesta empresa`,
      );
    }
  }

  private toMasked(tool: CustomTool) {
    const headers = this.executor.decryptHeaders(tool);
    return {
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      method: tool.method,
      url: tool.url,
      headers: Object.fromEntries(Object.keys(headers).map((k) => [k, '•••'])),
      headerKeys: Object.keys(headers),
      paramsSchema: tool.paramsSchema,
      timeoutMs: tool.timeoutMs,
      isActive: tool.isActive,
      createdAt: tool.createdAt,
    };
  }
}
