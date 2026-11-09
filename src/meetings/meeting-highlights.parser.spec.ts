import {
  hmsToSeconds,
  normalizeKind,
  parseHighlights,
} from './meeting-highlights.parser';

describe('hmsToSeconds', () => {
  it('converte HH:MM:SS, MM:SS e segundos', () => {
    expect(hmsToSeconds('00:12:03')).toBe(723);
    expect(hmsToSeconds('12:03')).toBe(723);
    expect(hmsToSeconds('90')).toBe(90);
    expect(hmsToSeconds('1:00:00')).toBe(3600);
  });

  it('retorna 0 para entrada inválida', () => {
    expect(hmsToSeconds('')).toBe(0);
    expect(hmsToSeconds('ab:cd')).toBe(0);
    expect(hmsToSeconds('   ')).toBe(0);
  });
});

describe('normalizeKind', () => {
  it('normaliza tipos conhecidos e cai em topic', () => {
    expect(normalizeKind('DECISION')).toBe('decision');
    expect(normalizeKind('Action')).toBe('action');
    expect(normalizeKind('topic')).toBe('topic');
    expect(normalizeKind('qualquer')).toBe('topic');
    expect(normalizeKind(undefined)).toBe('topic');
    expect(normalizeKind(42)).toBe('topic');
  });
});

describe('parseHighlights', () => {
  it('parseia JSON cercado por ```json e converte o ts', () => {
    const raw =
      '```json\n{"highlights":[{"kind":"decision","ts":"00:01:30","text":"Aprovado o orçamento","speaker":"Ana"}]}\n```';
    expect(parseHighlights(raw)).toEqual([
      {
        kind: 'decision',
        ts: 90,
        text: 'Aprovado o orçamento',
        speaker: 'Ana',
      },
    ]);
  });

  it('ignora itens sem texto e tolera prosa ao redor', () => {
    const raw =
      'Claro! Aqui vai: {"highlights":[{"kind":"topic","ts":"0:10","text":"  "},{"kind":"action","ts":"0:20","text":"Enviar a ata"}]} pronto';
    const out = parseHighlights(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'action', ts: 20, text: 'Enviar a ata' });
  });

  it('normaliza kind desconhecido para topic', () => {
    const raw =
      '{"highlights":[{"kind":"random","ts":"1:00","text":"Discussão geral"}]}';
    expect(parseHighlights(raw)[0].kind).toBe('topic');
  });

  it('retorna [] para lixo ou JSON inválido', () => {
    expect(parseHighlights('sem json aqui')).toEqual([]);
    expect(parseHighlights('{json quebrado}')).toEqual([]);
    expect(parseHighlights('')).toEqual([]);
  });
});
