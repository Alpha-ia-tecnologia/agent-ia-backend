import { DatasetColumnType } from '@prisma/client';
import * as XLSX from 'xlsx';

export const MAX_ROWS = 20000;
export const MAX_COLUMNS = 100;

export interface ImportedColumn {
  name: string;
  type: DatasetColumnType;
  position: number;
}

export interface ImportResult {
  columns: ImportedColumn[];
  rows: Record<string, unknown>[];
  warnings: string[];
}

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}(T.*)?$/, // ISO
  /^\d{1,2}\/\d{1,2}\/\d{4}$/, // dd/mm/yyyy
  /^\d{1,2}-\d{1,2}-\d{4}$/,
];
const BOOL_VALUES = new Set([
  'sim',
  'não',
  'nao',
  'true',
  'false',
  'verdadeiro',
  'falso',
]);
const CURRENCY_RE = /^\s*(r\$|\$|€)\s*-?[\d.,]+\s*$/i;

/** Converte "R$ 1.234,56" / "1,234.56" / "1234,56" em número. */
function parseNumeric(raw: string): number | null {
  let s = raw.replace(/^\s*(r\$|\$|€)\s*/i, '').trim();
  if (!s || !/^-?[\d.,]+%?$/.test(s)) return null;
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // formato brasileiro: . milhar, , decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!DATE_PATTERNS.some((re) => re.test(s))) return null;
  // dd/mm/yyyy → ISO
  const br = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (br) {
    const [, d, m, y] = br;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return Number.isNaN(Date.parse(s)) ? null : s.slice(0, 10);
}

/** Infere o tipo dominante de uma coluna a partir dos valores não vazios. */
function inferType(values: unknown[]): DatasetColumnType {
  const nonEmpty = values.filter(
    (v) => v !== null && v !== undefined && v !== '',
  );
  if (nonEmpty.length === 0) return DatasetColumnType.TEXT;
  let num = 0;
  let currency = 0;
  let date = 0;
  let bool = 0;
  for (const v of nonEmpty) {
    if (typeof v === 'number') {
      num++;
      continue;
    }
    if (typeof v === 'boolean') {
      bool++;
      continue;
    }
    if (v instanceof Date) {
      date++;
      continue;
    }
    const s = String(v).trim();
    if (CURRENCY_RE.test(s)) {
      currency++;
      num++;
    } else if (parseNumeric(s) !== null) {
      num++;
    } else if (parseDate(s) !== null) {
      date++;
    } else if (BOOL_VALUES.has(s.toLowerCase())) {
      bool++;
    }
  }
  const threshold = nonEmpty.length * 0.9;
  if (date >= threshold) return DatasetColumnType.DATE;
  if (bool >= threshold) return DatasetColumnType.BOOLEAN;
  if (num >= threshold) {
    return currency > nonEmpty.length * 0.3
      ? DatasetColumnType.CURRENCY
      : DatasetColumnType.NUMBER;
  }
  return DatasetColumnType.TEXT;
}

/** Texto de uma célula/valor de linha (planilha ou JSON do banco). Objetos
 *  viram JSON em vez de "[object Object]"; datas, ISO. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  return '';
}

function coerce(value: unknown, type: DatasetColumnType): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case DatasetColumnType.NUMBER:
    case DatasetColumnType.CURRENCY: {
      if (typeof value === 'number') return value;
      return parseNumeric(cellText(value));
    }
    case DatasetColumnType.DATE: {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return parseDate(cellText(value));
    }
    case DatasetColumnType.BOOLEAN: {
      if (typeof value === 'boolean') return value;
      const s = cellText(value).trim().toLowerCase();
      if (['sim', 'true', 'verdadeiro'].includes(s)) return true;
      if (['não', 'nao', 'false', 'falso'].includes(s)) return false;
      return null;
    }
    default:
      return typeof value === 'string' ? value.trim() : cellText(value);
  }
}

/** Lê xlsx/csv, infere tipos por coluna e coage os valores. */
export function importSpreadsheet(
  buffer: Buffer,
  fileName: string,
): ImportResult {
  const isCsv = /\.csv$/i.test(fileName);
  // CSV: o xlsx assume codepage 1252 por padrão — força UTF-8 (65001),
  // que é o encoding esperado dos exports modernos.
  const wb = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    ...(isCsv ? { codepage: 65001 } : {}),
  });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Planilha vazia');
  const sheet = wb.Sheets[sheetName];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  });
  if (raw.length < 2) {
    throw new Error(
      'A planilha precisa de um cabeçalho e ao menos uma linha de dados',
    );
  }

  const warnings: string[] = [];
  const headerRow = raw[0].map((h, i) => {
    const name = cellText(h).trim();
    return name || `coluna_${i + 1}`;
  });
  if (headerRow.length > MAX_COLUMNS) {
    throw new Error(`Máximo de ${MAX_COLUMNS} colunas`);
  }
  // dedup de nomes de coluna
  const seen = new Map<string, number>();
  const names = headerRow.map((n) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    return count === 0 ? n : `${n}_${count + 1}`;
  });

  let dataRows = raw
    .slice(1)
    .filter((r) => r.some((v) => v !== null && v !== ''));
  if (dataRows.length > MAX_ROWS) {
    warnings.push(
      `A planilha tem ${dataRows.length} linhas; importadas as primeiras ${MAX_ROWS}.`,
    );
    dataRows = dataRows.slice(0, MAX_ROWS);
  }

  const columns: ImportedColumn[] = names.map((name, i) => ({
    name,
    type: inferType(dataRows.map((r) => r[i])),
    position: i,
  }));

  const emptyByColumn = new Map<string, number>();
  const rows = dataRows.map((r) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      const v = coerce(r[i], col.type);
      if (v === null && r[i] !== null && r[i] !== '') {
        emptyByColumn.set(col.name, (emptyByColumn.get(col.name) ?? 0) + 1);
      }
      obj[col.name] = v;
    });
    return obj;
  });

  for (const [col, n] of emptyByColumn) {
    warnings.push(
      `Coluna "${col}": ${n} valor(es) não puderam ser convertidos e ficaram vazios.`,
    );
  }
  const missing = columns
    .map((c) => ({ c, n: rows.filter((r) => r[c.name] === null).length }))
    .filter(({ n }) => n > rows.length * 0.2);
  for (const { c, n } of missing) {
    warnings.push(`Coluna "${c.name}": ${n} de ${rows.length} células vazias.`);
  }

  return { columns, rows, warnings };
}
