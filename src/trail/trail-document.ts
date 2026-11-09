import PDFDocument from 'pdfkit';

/** Tudo o que o documento de uma estação concluída mostra. */
export interface TrailStationDocument {
  station: number;
  title: string;
  question: string;
  care: string;
  name: string;
  department: string | null;
  tableName: string;
  completedAt: string;
  material: string | null;
  steps: { title: string; note: string }[];
  result: string | null;
  lessons: { title: string; text: string }[];
}

export type ResultBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'item'; marker: string; text: string }
  | { kind: 'table'; rows: string[][] };

const NAVY = '#0b1b52';
const BLUE = '#2747c9';
const LIME = '#d8f23a';
const INK = '#14213f';
const MUTED = '#3a4766';
const RULE = '#d6dccb';
const WHITE = '#f4f7ff';
const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const MARGIN = 48;
const BODY = 10.5;

const SUBSTITUTES: Record<string, string> = {
  '→': '->',
  '➜': '->',
  '➔': '->',
  '⇒': '=>',
  '←': '<-',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '−': '-',
  '‑': '-',
  '✓': '-',
  '✔': '-',
  '✅': '-',
  ' ': ' ',
};
const SUBSTITUTABLE = new RegExp(
  `[${Object.keys(SUBSTITUTES).join('')}]`,
  'gu',
);
/** As fontes padrão do PDF só escrevem os caracteres da página WinAnsi. */
const OUTSIDE_WIN_ANSI =
  /[^\n\t\x20-\x7e\xa1-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/gu;

export function cleanForPdf(text: string): string {
  return text
    .normalize('NFC')
    .replace(SUBSTITUTABLE, (char) => SUBSTITUTES[char])
    .replace(OUTSIDE_WIN_ANSI, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Mantém só o negrito; links, código e itálico viram texto simples. */
function plainInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
}

/** Converte o Markdown da resposta da IA em blocos simples para o PDF. */
export function parseResult(markdown: string): ResultBlock[] {
  const blocks: ResultBlock[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue;
    if (line.includes('|') && /^[\s:|-]+$/.test(line)) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^(\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        text: plainInline(heading[1]).replace(/\*\*/g, ''),
      });
    } else if (bullet) {
      blocks.push({ kind: 'item', marker: '•', text: plainInline(bullet[1]) });
    } else if (numbered) {
      blocks.push({
        kind: 'item',
        marker: numbered[1],
        text: plainInline(numbered[2]),
      });
    } else if (line.startsWith('|')) {
      const cells = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => plainInline(cell.trim()).replace(/\*\*/g, ''));
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'table') last.rows.push(cells);
      else blocks.push({ kind: 'table', rows: [cells] });
    } else {
      blocks.push({
        kind: 'paragraph',
        text: plainInline(line.replace(/^>\s?/, '')),
      });
    }
  }
  return blocks;
}

/**
 * O resultado do especialista não tem marca própria na conversa: é a fala
 * mais longa de quem não é o Guia. A pergunta final era para a conversa e
 * não entra no documento.
 */
export function pickResult(
  messages: { authorName: string | null; content: string }[],
  guideName: string,
): string | null {
  const longest = messages
    .filter((m) => m.authorName !== guideName)
    .reduce<string | null>(
      (best, m) =>
        best === null || m.content.length > best.length ? m.content : best,
      null,
    );
  if (longest === null) return null;
  const paragraphs = longest.trim().split(/\n\s*\n/);
  if (
    paragraphs.length > 1 &&
    paragraphs[paragraphs.length - 1].endsWith('?')
  ) {
    paragraphs.pop();
  }
  return paragraphs.join('\n\n');
}

/** A anotação às vezes repete o nome da etapa: "Dados: planilha..." */
export function withoutLabel(note: string, title: string): string {
  const prefix = `${title}:`.toLowerCase();
  if (!note.toLowerCase().startsWith(prefix)) return note;
  const rest = note.slice(prefix.length).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : note;
}

export function stationPdfName(data: TrailStationDocument): string {
  const slug = data.title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `estacao-${data.station}-${slug}.pdf`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza',
    dateStyle: 'long',
  }).format(new Date(iso));
}

type Doc = InstanceType<typeof PDFDocument>;

const contentWidth = (doc: Doc) => doc.page.width - MARGIN * 2;

function ensureSpace(doc: Doc, height: number) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Escreve texto com trechos em **negrito**, sem quebrar o fluxo da linha. */
function writeRich(doc: Doc, text: string, x: number, width: number) {
  const segments = cleanForPdf(text)
    .split('**')
    .map((part, index) => ({ part, bold: index % 2 === 1 }))
    .filter(({ part }) => part);
  doc.fontSize(BODY).fillColor(INK);
  segments.forEach(({ part, bold }, index) => {
    const options = {
      width,
      lineGap: 2.5,
      continued: index < segments.length - 1,
    };
    doc.font(bold ? BOLD : REGULAR);
    if (index === 0) doc.text(part, x, doc.y, options);
    else doc.text(part, options);
  });
}

function writeSection(doc: Doc, title: string) {
  ensureSpace(doc, 70);
  doc.moveDown(1);
  doc
    .font(BOLD)
    .fontSize(9.5)
    .fillColor(BLUE)
    .text(cleanForPdf(title).toUpperCase(), MARGIN, doc.y, {
      width: contentWidth(doc),
      characterSpacing: 0.8,
    });
  const line = doc.y + 3;
  doc
    .moveTo(MARGIN, line)
    .lineTo(doc.page.width - MARGIN, line)
    .lineWidth(0.75)
    .strokeColor(RULE)
    .stroke();
  doc.y = line + 9;
}

function writeHeader(doc: Doc, data: TrailStationDocument) {
  const width = contentWidth(doc);
  const title = cleanForPdf(`Estação ${data.station} · ${data.title}`);
  doc.font(BOLD).fontSize(22);
  const titleHeight = doc.heightOfString(title, { width });
  const meta = cleanForPdf(
    [data.name, data.department, data.tableName, formatDate(data.completedAt)]
      .filter(Boolean)
      .join(' · '),
  );
  doc.font(REGULAR).fontSize(10.5);
  const metaHeight = doc.heightOfString(meta, { width });
  const band = 62 + titleHeight + 10 + metaHeight + 24;

  doc.rect(0, 0, doc.page.width, band).fill(NAVY);
  doc.rect(0, band, doc.page.width, 4).fill(LIME);
  doc
    .font(BOLD)
    .fontSize(9.5)
    .fillColor(LIME)
    .text('TRILHA DA INOVAÇÃO · SEMINÁRIO GOVERNO DO FUTURO', MARGIN, 40, {
      width,
      characterSpacing: 0.8,
    });
  doc
    .font(BOLD)
    .fontSize(22)
    .fillColor(WHITE)
    .text(title, MARGIN, 62, { width });
  doc
    .font(REGULAR)
    .fontSize(10.5)
    .fillColor(WHITE)
    .text(meta, MARGIN, 62 + titleHeight + 10, { width });
  doc.x = MARGIN;
  doc.y = band + 24;
}

function writeTable(doc: Doc, rows: string[][]) {
  const columns = Math.max(...rows.map((row) => row.length));
  ensureSpace(doc, 70);
  doc.x = MARGIN;
  doc.font(REGULAR).fontSize(9).fillColor(INK);
  doc.table({
    defaultStyle: { padding: 4, border: 0.5, borderColor: RULE },
    rowStyles: (row) =>
      row === 0 ? { backgroundColor: '#e8ecf6', font: { src: BOLD } } : {},
    data: rows.map((row) =>
      Array.from({ length: columns }, (_, column) =>
        cleanForPdf(row[column] ?? ''),
      ),
    ),
  });
  doc.x = MARGIN;
  doc.moveDown(0.6);
}

function writeResult(doc: Doc, markdown: string) {
  const width = contentWidth(doc);
  for (const block of parseResult(markdown)) {
    if (block.kind === 'heading') {
      ensureSpace(doc, 44);
      doc.moveDown(0.3);
      doc
        .font(BOLD)
        .fontSize(11.5)
        .fillColor(NAVY)
        .text(cleanForPdf(block.text), MARGIN, doc.y, { width });
      doc.moveDown(0.25);
    } else if (block.kind === 'table') {
      writeTable(doc, block.rows);
    } else if (block.kind === 'item') {
      ensureSpace(doc, 30);
      const top = doc.y;
      doc
        .font(REGULAR)
        .fontSize(BODY)
        .fillColor(BLUE)
        .text(block.marker, MARGIN, top, { width: 20, lineBreak: false });
      doc.y = top;
      writeRich(doc, block.text, MARGIN + 20, width - 20);
      doc.moveDown(0.25);
    } else {
      ensureSpace(doc, 30);
      writeRich(doc, block.text, MARGIN, width);
      doc.moveDown(0.45);
    }
  }
}

function writeFooters(doc: Doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let index = 0; index < count; index += 1) {
    doc.switchToPage(start + index);
    const reserved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 36;
    doc
      .moveTo(MARGIN, y - 8)
      .lineTo(doc.page.width - MARGIN, y - 8)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    doc
      .font(REGULAR)
      .fontSize(8)
      .fillColor(MUTED)
      .text('A IA sugere; você decide e assina.', MARGIN, y, {
        width: contentWidth(doc) - 70,
        lineBreak: false,
      })
      .text(`${index + 1} de ${count}`, doc.page.width - MARGIN - 70, y, {
        width: 70,
        align: 'right',
        lineBreak: false,
      });
    doc.page.margins.bottom = reserved;
  }
}

export function renderStationPdf(data: TrailStationDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: MARGIN,
        bottom: MARGIN + 18,
        left: MARGIN,
        right: MARGIN,
      },
      bufferPages: true,
      info: {
        Title: cleanForPdf(`Estação ${data.station}: ${data.title}`),
        Author: 'Trilha da Inovação',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = contentWidth(doc);
    writeHeader(doc, data);
    doc
      .font(BOLD)
      .fontSize(12.5)
      .fillColor(NAVY)
      .text(cleanForPdf(data.question), MARGIN, doc.y, { width, lineGap: 2 });
    if (data.material) {
      doc.moveDown(0.5);
      doc
        .font(REGULAR)
        .fontSize(BODY)
        .fillColor(MUTED)
        .text(cleanForPdf(`Material analisado: ${data.material}`), { width });
    }

    if (data.steps.length > 0) {
      writeSection(doc, 'O que você construiu');
      for (const step of data.steps) {
        ensureSpace(doc, 44);
        doc
          .font(BOLD)
          .fontSize(BODY)
          .fillColor(NAVY)
          .text(cleanForPdf(step.title), MARGIN, doc.y, { width });
        doc.moveDown(0.15);
        writeRich(doc, step.note, MARGIN, width);
        doc.moveDown(0.6);
      }
    }

    if (data.result) {
      writeSection(doc, 'Resultado com a IA');
      writeResult(doc, data.result);
    }

    if (data.lessons.length > 0) {
      writeSection(doc, 'O que você leva');
      for (const lesson of data.lessons) {
        ensureSpace(doc, 44);
        doc
          .font(BOLD)
          .fontSize(BODY)
          .fillColor(NAVY)
          .text(cleanForPdf(lesson.title), MARGIN, doc.y, { width });
        doc.moveDown(0.15);
        writeRich(doc, lesson.text, MARGIN, width);
        doc.moveDown(0.6);
      }
    }

    writeSection(doc, 'Cuidado desta estação');
    writeRich(doc, data.care, MARGIN, width);

    writeFooters(doc);
    doc.end();
  });
}
