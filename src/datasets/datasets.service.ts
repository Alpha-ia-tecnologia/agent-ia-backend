import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatasetColumnType, DatasetQuality, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { importSpreadsheet, type ImportResult } from './dataset-import';

const ALLOWED_EXT = ['.xlsx', '.xls', '.csv'];

@Injectable()
export class DatasetsService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: string) {
    return this.prisma.dataset.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  async get(companyId: string, id: string) {
    const dataset = await this.prisma.dataset.findFirst({
      where: { id, companyId },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
    if (!dataset) throw new NotFoundException('Base de dados não encontrada');
    return dataset;
  }

  async rows(companyId: string, id: string, page = 1, pageSize = 50) {
    await this.get(companyId, id);
    const take = Math.min(Math.max(pageSize, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const [rows, total] = await Promise.all([
      this.prisma.datasetRow.findMany({
        where: { datasetId: id },
        orderBy: { rowIndex: 'asc' },
        skip,
        take,
        select: { rowIndex: true, data: true },
      }),
      this.prisma.datasetRow.count({ where: { datasetId: id } }),
    ]);
    return { rows, total, page: Math.max(page, 1), pageSize: take };
  }

  async createFromFile(
    companyId: string,
    file: Express.Multer.File,
    name?: string,
    description?: string,
  ) {
    const ext = (
      file.originalname.match(/\.[a-z0-9]+$/i)?.[0] ?? ''
    ).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      throw new BadRequestException(
        'Formato não suportado: use .xlsx, .xls ou .csv',
      );
    }
    let parsed: ImportResult;
    try {
      parsed = importSpreadsheet(file.buffer, file.originalname);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const dataset = await this.prisma.dataset.create({
      data: {
        companyId,
        name: name?.trim() || file.originalname.replace(/\.[a-z0-9]+$/i, ''),
        description: description?.trim() ?? '',
        fileName: file.originalname,
        rowCount: parsed.rows.length,
        quality: parsed.warnings.length
          ? DatasetQuality.WITH_ISSUES
          : DatasetQuality.OK,
        qualityNotes: parsed.warnings,
        columns: {
          create: parsed.columns.map((c) => ({
            name: c.name,
            type: c.type,
            position: c.position,
          })),
        },
      },
      include: { columns: { orderBy: { position: 'asc' } } },
    });

    // insere linhas em lotes para não estourar o tamanho da query
    const BATCH = 1000;
    for (let i = 0; i < parsed.rows.length; i += BATCH) {
      await this.prisma.datasetRow.createMany({
        data: parsed.rows.slice(i, i + BATCH).map((data, j) => ({
          datasetId: dataset.id,
          rowIndex: i + j,
          data: data as Prisma.InputJsonValue,
        })),
      });
    }
    return dataset;
  }

  async update(
    companyId: string,
    id: string,
    dto: { name?: string; description?: string },
  ) {
    await this.get(companyId, id);
    return this.prisma.dataset.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
      },
      include: { columns: { orderBy: { position: 'asc' } } },
    });
  }

  /** Ajusta tipo/descrição de uma coluna (a coerção acontece na consulta). */
  async updateColumn(
    companyId: string,
    datasetId: string,
    columnId: string,
    dto: { type?: string; description?: string },
  ) {
    await this.get(companyId, datasetId);
    const column = await this.prisma.datasetColumn.findFirst({
      where: { id: columnId, datasetId },
    });
    if (!column) throw new NotFoundException('Coluna não encontrada');
    if (dto.type && !(dto.type in DatasetColumnType)) {
      throw new BadRequestException('Tipo de coluna inválido');
    }
    return this.prisma.datasetColumn.update({
      where: { id: columnId },
      data: {
        ...(dto.type ? { type: dto.type as DatasetColumnType } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
      },
    });
  }

  /** Exclusão é ação humana (admins); agentes não têm rota de exclusão. */
  async remove(companyId: string, id: string) {
    await this.get(companyId, id);
    await this.prisma.dataset.delete({ where: { id } });
    return { deleted: true };
  }
}
