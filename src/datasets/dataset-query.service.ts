import { Injectable } from '@nestjs/common';
import { DatasetColumnType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Motor determinístico de consulta sobre DatasetRow (JSONB).
 * O agente descreve a consulta em JSON; o SQL é montado aqui com colunas
 * validadas contra o catálogo — o LLM nunca escreve SQL nem inventa números.
 */

export interface DatasetFilter {
  coluna: string;
  operador: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contem';
  valor: string | number | boolean;
}

export interface DatasetAggregation {
  funcao: 'soma' | 'media' | 'min' | 'max' | 'contagem';
  coluna?: string;
}

export interface DatasetQuery {
  filtros?: DatasetFilter[];
  agrupar_por?: string[];
  agregacoes?: DatasetAggregation[];
  ordenar_por?: string;
  ordem?: 'asc' | 'desc';
  limite?: number;
}

const NUMERIC = new Set<DatasetColumnType>([
  DatasetColumnType.NUMBER,
  DatasetColumnType.CURRENCY,
]);

const AGG_SQL: Record<DatasetAggregation['funcao'], string> = {
  soma: 'SUM',
  media: 'AVG',
  min: 'MIN',
  max: 'MAX',
  contagem: 'COUNT',
};

@Injectable()
export class DatasetQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Expressão SQL para acessar a coluna com cast pelo tipo. Nome já validado. */
  private colExpr(name: string, type: DatasetColumnType): Prisma.Sql {
    const accessor = Prisma.sql`data->>${name}`;
    if (NUMERIC.has(type)) return Prisma.sql`(${accessor})::numeric`;
    if (type === DatasetColumnType.DATE) return Prisma.sql`(${accessor})::date`;
    if (type === DatasetColumnType.BOOLEAN)
      return Prisma.sql`(${accessor})::boolean`;
    return accessor;
  }

  async query(
    datasetId: string,
    columns: { name: string; type: DatasetColumnType }[],
    q: DatasetQuery,
  ): Promise<{ erro?: string; linhas?: Record<string, unknown>[] }> {
    const byName = new Map(columns.map((c) => [c.name, c]));
    const resolve = (name: string) => {
      const col = byName.get(name);
      if (!col) {
        const lower = name.toLowerCase();
        return columns.find((c) => c.name.toLowerCase() === lower);
      }
      return col;
    };

    // ---- WHERE
    const where: Prisma.Sql[] = [Prisma.sql`"datasetId" = ${datasetId}`];
    for (const f of q.filtros ?? []) {
      const col = resolve(f.coluna);
      if (!col) return { erro: `Coluna desconhecida no filtro: "${f.coluna}"` };
      const expr = this.colExpr(col.name, col.type);
      const value: Prisma.Sql = NUMERIC.has(col.type)
        ? Prisma.sql`${Number(f.valor)}`
        : col.type === DatasetColumnType.DATE
          ? Prisma.sql`${String(f.valor)}::date`
          : Prisma.sql`${String(f.valor)}`;
      switch (f.operador) {
        case '=':
          where.push(
            col.type === DatasetColumnType.TEXT
              ? Prisma.sql`LOWER(data->>${col.name}) = LOWER(${String(f.valor)})`
              : Prisma.sql`${expr} = ${value}`,
          );
          break;
        case '!=':
          where.push(
            col.type === DatasetColumnType.TEXT
              ? Prisma.sql`LOWER(data->>${col.name}) <> LOWER(${String(f.valor)})`
              : Prisma.sql`${expr} <> ${value}`,
          );
          break;
        case '>':
          where.push(Prisma.sql`${expr} > ${value}`);
          break;
        case '>=':
          where.push(Prisma.sql`${expr} >= ${value}`);
          break;
        case '<':
          where.push(Prisma.sql`${expr} < ${value}`);
          break;
        case '<=':
          where.push(Prisma.sql`${expr} <= ${value}`);
          break;
        case 'contem':
          where.push(
            Prisma.sql`data->>${col.name} ILIKE ${'%' + String(f.valor) + '%'}`,
          );
          break;
        default:
          return { erro: `Operador inválido: "${String(f.operador)}"` };
      }
    }
    const whereSql = Prisma.join(where, ' AND ');

    // ---- SELECT / GROUP BY
    const groups = q.agrupar_por ?? [];
    const aggs = q.agregacoes ?? [];
    const limit = Math.min(Math.max(q.limite ?? 100, 1), 500);

    const selectParts: Prisma.Sql[] = [];
    const groupExprs: Prisma.Sql[] = [];
    for (const g of groups) {
      const col = resolve(g);
      if (!col) return { erro: `Coluna desconhecida em agrupar_por: "${g}"` };
      const expr = Prisma.sql`data->>${col.name}`;
      selectParts.push(
        Prisma.sql`${expr} AS ${Prisma.raw(`"${col.name.replace(/"/g, '')}"`)}`,
      );
      groupExprs.push(expr);
    }
    const aggAliases: string[] = [];
    for (const a of aggs) {
      if (!(a.funcao in AGG_SQL))
        return { erro: `Função inválida: "${a.funcao}"` };
      if (a.funcao === 'contagem' && !a.coluna) {
        selectParts.push(Prisma.sql`COUNT(*)::float AS "contagem"`);
        aggAliases.push('contagem');
        continue;
      }
      if (!a.coluna) return { erro: `A função "${a.funcao}" exige uma coluna` };
      const col = resolve(a.coluna);
      if (!col)
        return { erro: `Coluna desconhecida na agregação: "${a.coluna}"` };
      if (a.funcao !== 'contagem' && !NUMERIC.has(col.type)) {
        return {
          erro: `A função "${a.funcao}" só se aplica a colunas numéricas ("${col.name}" é ${col.type})`,
        };
      }
      const alias = `${a.funcao}_${col.name}`.replace(/"/g, '');
      selectParts.push(
        Prisma.sql`${Prisma.raw(AGG_SQL[a.funcao])}(${this.colExpr(col.name, col.type)})::float AS ${Prisma.raw(`"${alias}"`)}`,
      );
      aggAliases.push(alias);
    }

    let sql: Prisma.Sql;
    if (groups.length || aggs.length) {
      if (selectParts.length === 0) {
        return { erro: 'Informe agregações e/ou agrupar_por' };
      }
      // ordenar: por alias de agregação ou coluna de grupo
      let orderSql = Prisma.empty;
      if (q.ordenar_por) {
        const dir = q.ordem === 'asc' ? Prisma.raw('ASC') : Prisma.raw('DESC');
        const target = q.ordenar_por.trim();
        if (aggAliases.includes(target)) {
          orderSql = Prisma.sql`ORDER BY ${Prisma.raw(`"${target.replace(/"/g, '')}"`)} ${dir}`;
        } else {
          const col = resolve(target);
          if (!col)
            return { erro: `Coluna desconhecida em ordenar_por: "${target}"` };
          const groupPos = groups.findIndex(
            (g) => resolve(g)?.name === col.name,
          );
          if (groupPos === -1) {
            return { erro: `ordenar_por deve ser um grupo ou uma agregação` };
          }
          // posição no SELECT (mesma razão do GROUP BY posicional)
          orderSql = Prisma.sql`ORDER BY ${Prisma.raw(String(groupPos + 1))} ${dir}`;
        }
      } else if (aggAliases.length) {
        orderSql = Prisma.sql`ORDER BY ${Prisma.raw(`"${aggAliases[0]}"`)} DESC`;
      }
      // GROUP BY posicional: `data->>$1` no SELECT e no GROUP BY viram
      // parâmetros distintos e o Postgres não os reconhece como a mesma expressão.
      const groupSql = groupExprs.length
        ? Prisma.raw(`GROUP BY ${groupExprs.map((_, i) => i + 1).join(', ')}`)
        : Prisma.empty;
      sql = Prisma.sql`SELECT ${Prisma.join(selectParts, ', ')} FROM "DatasetRow"
        WHERE ${whereSql} ${groupSql} ${orderSql} LIMIT ${limit}`;
    } else {
      // listagem simples de linhas filtradas
      let orderSql = Prisma.sql`ORDER BY "rowIndex" ASC`;
      if (q.ordenar_por) {
        const col = resolve(q.ordenar_por);
        if (!col)
          return {
            erro: `Coluna desconhecida em ordenar_por: "${q.ordenar_por}"`,
          };
        const dir = q.ordem === 'asc' ? Prisma.raw('ASC') : Prisma.raw('DESC');
        orderSql = Prisma.sql`ORDER BY ${this.colExpr(col.name, col.type)} ${dir}`;
      }
      sql = Prisma.sql`SELECT data FROM "DatasetRow" WHERE ${whereSql} ${orderSql} LIMIT ${limit}`;
    }

    try {
      const raw = await this.prisma.$queryRaw<Record<string, unknown>[]>(sql);
      const linhas =
        groups.length || aggs.length
          ? raw
          : raw.map((r) => r.data as Record<string, unknown>);
      return { linhas };
    } catch (err) {
      return {
        erro: `Falha ao executar a consulta: ${(err as Error).message.slice(0, 200)}`,
      };
    }
  }
}
