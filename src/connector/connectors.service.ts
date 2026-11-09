import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorRegistryService } from './connector-registry.service';

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class ConnectorsService {
  // códigos de pareamento de uso único (app desktop): code -> tenant
  private readonly pairCodes = new Map<
    string,
    { companyId: string; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistryService,
  ) {}

  /** Gera um código curto de uso único para parear o app desktop. */
  createPairCode(companyId: string) {
    // limpa expirados de passagem
    for (const [code, entry] of this.pairCodes) {
      if (entry.expiresAt < Date.now()) this.pairCodes.delete(code);
    }
    const code = String(randomInt(0, 1_000_000_000)).padStart(9, '0');
    const formatted = `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
    this.pairCodes.set(formatted, {
      companyId,
      expiresAt: Date.now() + PAIR_CODE_TTL_MS,
    });
    return { code: formatted, expiresInSeconds: PAIR_CODE_TTL_MS / 1000 };
  }

  /** Troca o código (uso único) por um token de conector para o dispositivo. */
  async pair(code: string, deviceName: string) {
    const entry = this.pairCodes.get(code);
    this.pairCodes.delete(code); // uso único mesmo em falha posterior
    if (!entry || entry.expiresAt < Date.now()) {
      throw new BadRequestException(
        'Código de pareamento inválido ou expirado — gere um novo no painel.',
      );
    }
    return this.create(entry.companyId, deviceName);
  }

  /** Cria (ou reaproveita) o conector e retorna o token — exibido uma única vez.
   *  Re-parear um dispositivo com o MESMO nome reusa a entrada existente (novo
   *  token, reativa) em vez de duplicar — evita vários "Notebook de Kawann". */
  async create(companyId: string, name: string) {
    const token = `aaoc_${randomBytes(32).toString('hex')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const existing = await this.prisma.connector.findFirst({
      where: { companyId, name },
      orderBy: { createdAt: 'desc' },
    });
    const connector = existing
      ? await this.prisma.connector.update({
          where: { id: existing.id },
          data: { tokenHash, revokedAt: null },
        })
      : await this.prisma.connector.create({
          data: { companyId, name, tokenHash },
        });
    return { id: connector.id, name: connector.name, token };
  }

  async list(companyId: string) {
    const connectors = await this.prisma.connector.findMany({
      where: { companyId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return connectors.map((c) => {
      const online = this.registry.isDeviceOnline(companyId, c.id);
      const live = online
        ? this.registry
            .listOnline(companyId)
            .find((d) => d.connectorId === c.id)
        : undefined;
      return {
        id: c.id,
        name: c.name,
        status: online ? ('online' as const) : ('offline' as const),
        lastSeenAt: c.lastSeenAt,
        folders:
          live?.folders ?? (c.folders as { path: string; readOnly: boolean }[]),
        createdAt: c.createdAt,
      };
    });
  }

  async revoke(companyId: string, id: string) {
    const connector = await this.prisma.connector.findFirst({
      where: { id, companyId, revokedAt: null },
    });
    if (!connector) throw new NotFoundException('Conector não encontrado');
    await this.prisma.connector.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    this.registry.disconnect(id);
    return { revoked: true };
  }
}
