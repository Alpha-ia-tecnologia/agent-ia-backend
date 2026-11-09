import {
  cleanForPdf,
  parseResult,
  pickResult,
  renderStationPdf,
  stationPdfName,
  withoutLabel,
  type TrailStationDocument,
} from './trail-document';

const data = (
  over: Partial<TrailStationDocument> = {},
): TrailStationDocument => ({
  station: 1,
  title: 'Captação de recursos',
  question: 'Como encontrar recursos para a sua secretaria?',
  care: 'Confira prazos e regras no edital original.',
  name: 'Ana Souza',
  department: 'Saúde',
  tableName: 'Mesa 1',
  completedAt: '2026-11-09T18:30:00.000Z',
  material: 'Edital de apoio',
  steps: [{ title: 'Agenda', note: 'Reduzir a fila de consultas' }],
  result: '## Resumo\n\n- **Prazo**: 30 dias\n\n1. Reunir a equipe',
  lessons: [{ title: 'Confira na fonte', text: 'A IA pode errar.' }],
  ...over,
});

describe('cleanForPdf', () => {
  it('mantém os acentos e a pontuação do português', () => {
    expect(cleanForPdf('Ação nº 1 “coração” – é só º ª')).toBe(
      'Ação nº 1 “coração” – é só º ª',
    );
  });

  it('troca símbolos que a fonte não escreve e remove emojis', () => {
    expect(cleanForPdf('A → B ≥ 3 ✅ pronto 🎉')).toBe('A -> B >= 3 - pronto');
  });
});

describe('parseResult', () => {
  it('reconhece títulos, listas e parágrafos', () => {
    expect(
      parseResult('# Título\n\nTexto **forte**\n\n- item\n2) outro\n\n---'),
    ).toEqual([
      { kind: 'heading', text: 'Título' },
      { kind: 'paragraph', text: 'Texto **forte**' },
      { kind: 'item', marker: '•', text: 'item' },
      { kind: 'item', marker: '2)', text: 'outro' },
    ]);
  });

  it('agrupa a tabela, descarta o separador e mantém células vazias', () => {
    expect(parseResult('| Fonte | Valor |\n|---|---|\n| **A** |  |')).toEqual([
      {
        kind: 'table',
        rows: [
          ['Fonte', 'Valor'],
          ['A', ''],
        ],
      },
    ]);
  });

  it('remove links, código e itálico', () => {
    expect(parseResult('Veja [o site](http://x) e `isto` e *aquilo*.')).toEqual(
      [{ kind: 'paragraph', text: 'Veja o site e isto e aquilo.' }],
    );
  });
});

describe('pickResult', () => {
  it('escolhe a fala mais longa de quem não é o Guia', () => {
    expect(
      pickResult(
        [
          { authorName: 'Guia', content: 'x'.repeat(900) },
          { authorName: 'Especialista', content: 'curta' },
          { authorName: 'Especialista', content: 'resultado completo' },
        ],
        'Guia',
      ),
    ).toBe('resultado completo');
  });

  it('retira a pergunta final, que era para a conversa', () => {
    expect(
      pickResult(
        [{ authorName: 'E', content: 'Achado.\n\nTabela.\n\nQual preocupa?' }],
        'Guia',
      ),
    ).toBe('Achado.\n\nTabela.');
  });

  it('sem fala de especialista, não há resultado', () => {
    expect(pickResult([{ authorName: 'Guia', content: 'a' }], 'Guia')).toBe(
      null,
    );
  });
});

describe('renderStationPdf', () => {
  it('gera um PDF', async () => {
    const pdf = await renderStationPdf(data());

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('não falha com seções vazias, emojis e textos longos', async () => {
    const pdf = await renderStationPdf(
      data({
        department: null,
        material: null,
        steps: [],
        result: `## 🎯 Plano\n\n${'**Longo** texto → '.repeat(600)}`,
        lessons: [],
      }),
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('withoutLabel', () => {
  it('retira o nome da etapa repetido na anotação', () => {
    expect(withoutLabel('Dados: planilha de obras', 'Dados')).toBe(
      'Planilha de obras',
    );
  });

  it('mantém a anotação que não repete o nome', () => {
    expect(withoutLabel('Planilha de obras', 'Dados')).toBe(
      'Planilha de obras',
    );
  });
});

describe('stationPdfName', () => {
  it('monta um nome de arquivo sem acentos', () => {
    expect(stationPdfName(data())).toBe('estacao-1-captacao-de-recursos.pdf');
  });
});
