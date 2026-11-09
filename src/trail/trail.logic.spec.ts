import {
  CHEGADA,
  firstPending,
  isStation,
  maxOpenStation,
  parseCandidates,
  parsePlan,
  parseRoute,
  parseTurn,
  tableQuorum,
  winningStation,
  withoutQuestions,
} from './trail.logic';

describe('firstPending', () => {
  it('começa na estação 1', () => {
    expect(firstPending([])).toBe(1);
  });

  it('não pula estação não concluída', () => {
    expect(firstPending([1, 3])).toBe(2);
  });

  it('passa do total quando todas foram concluídas', () => {
    expect(firstPending([1, 2, 3, 4, 5])).toBe(6);
  });
});

describe('maxOpenStation', () => {
  it('só abre a próxima depois de concluir a anterior', () => {
    expect(maxOpenStation([], 0, 0)).toBe(1);
    expect(maxOpenStation([1], 0, 0)).toBe(2);
  });

  it('antes da Largada nenhuma estação abre', () => {
    expect(maxOpenStation([], 0, 0, false)).toBe(0);
  });

  it('o organizador libera sem exigir conclusão', () => {
    expect(maxOpenStation([], 3, 0)).toBe(3);
    expect(maxOpenStation([1], 0, 4)).toBe(4);
    expect(maxOpenStation([], 2, 0, false)).toBe(2);
  });

  it('nunca passa da última estação', () => {
    expect(maxOpenStation([1, 2, 3, 4, 5], 0, 0)).toBe(5);
    expect(maxOpenStation([], 9, 0)).toBe(5);
  });
});

describe('tableQuorum', () => {
  it('pede metade da mesa, arredondando para cima', () => {
    expect(tableQuorum(11)).toBe(6);
    expect(tableQuorum(10)).toBe(5);
    expect(tableQuorum(1)).toBe(1);
  });

  it('nunca pede menos de uma pessoa', () => {
    expect(tableQuorum(0)).toBe(1);
  });
});

describe('winningStation', () => {
  it('escolhe a ideia mais votada', () => {
    expect(winningStation([2, 3, 3], [1, 2, 3])).toBe(3);
  });

  it('no empate fica a estação que veio primeiro', () => {
    expect(winningStation([4, 2], [2, 4])).toBe(2);
  });

  it('sem votos não há vencedora', () => {
    expect(winningStation([], [1, 2])).toBeNull();
  });
});

describe('parseRoute', () => {
  const allowed = ['acessibilidade', 'sustentabilidade'];

  it('aceita um especialista permitido', () => {
    expect(parseRoute('{"agente":"acessibilidade"}', allowed)).toBe(
      'acessibilidade',
    );
  });

  it('recusa especialista desconhecido ou JSON inválido', () => {
    expect(parseRoute('{"agente":"outro"}', allowed)).toBeNull();
    expect(parseRoute('nada', allowed)).toBeNull();
  });
});

describe('parseTurn', () => {
  it('lê a mensagem, as opções, a nota e a ideia', () => {
    expect(
      parseTurn(
        '{"resolvido":true,"mensagem":" Certo. ","opcoes":["A","B"],"nota":"n","ideia":"i"}',
      ),
    ).toEqual({
      resolved: true,
      message: 'Certo.',
      options: ['A', 'B'],
      note: 'n',
      idea: 'i',
      bridge: '',
    });
  });

  it('descarta opções vazias ou longas e limita a quantidade', () => {
    const long = 'x'.repeat(61);
    const parsed = parseTurn(
      JSON.stringify({
        mensagem: 'm',
        opcoes: ['a', '', long, 'b', 'c', 'd', 'e'],
      }),
    );
    expect(parsed?.options).toEqual(['a', 'b', 'c', 'd']);
  });

  it('assume não resolvido quando o campo não vem', () => {
    expect(parseTurn('{"mensagem":"m"}')?.resolved).toBe(false);
  });

  it('recusa mensagem vazia ou JSON inválido', () => {
    expect(parseTurn('{"mensagem":"  "}')).toBeNull();
    expect(parseTurn('texto')).toBeNull();
  });
});

describe('parseCandidates', () => {
  it('mantém uma ideia por estação válida, em ordem', () => {
    const raw = JSON.stringify({
      ideias: [
        { estacao: 3, titulo: 'T3', resumo: 'R3' },
        { estacao: 1, titulo: 'T1', resumo: 'R1' },
        { estacao: 1, titulo: 'Repetida', resumo: 'R' },
        { estacao: 9, titulo: 'Fora', resumo: 'R' },
      ],
    });
    expect(parseCandidates(raw, [1, 3])).toEqual([
      { station: 1, title: 'T1', summary: 'R1' },
      { station: 3, title: 'T3', summary: 'R3' },
    ]);
  });

  it('recusa resposta sem ideias aproveitáveis', () => {
    expect(parseCandidates('{"ideias":[]}', [1])).toBeNull();
    expect(parseCandidates('x', [1])).toBeNull();
  });
});

describe('isStation', () => {
  it('Largada e Chegada não são estações', () => {
    expect(isStation(0)).toBe(false);
    expect(isStation(CHEGADA)).toBe(false);
  });

  it('as cinco estações contam', () => {
    expect([1, 2, 3, 4, 5].every((n) => isStation(n))).toBe(true);
  });
});

describe('parsePlan', () => {
  const plan = {
    titulo: 'Agenda sem filas',
    objetivo: 'Como podemos reduzir a espera?',
    dor: { descricao: 'Espera longa' },
    solucao: { descricao: 'Lembretes' },
    fases: [{ acoes: [{ acao: 'Confirmar o dado' }] }],
  };

  it('aceita o plano completo', () => {
    expect(parsePlan(JSON.stringify(plan))?.titulo).toBe('Agenda sem filas');
  });

  it('recusa plano sem fases ou com fase vazia', () => {
    expect(parsePlan(JSON.stringify({ ...plan, fases: [] }))).toBeNull();
    expect(
      parsePlan(JSON.stringify({ ...plan, fases: [{ acoes: [] }] })),
    ).toBeNull();
  });

  it('recusa texto cortado', () => {
    expect(parsePlan('{"titulo": "Agenda')).toBeNull();
  });
});

describe('parseTurn com transição', () => {
  it('separa a transição da reação do Guia', () => {
    const turn = parseTurn(
      JSON.stringify({
        resolvido: true,
        mensagem: 'Reação',
        opcoes: [],
        nota: 'n',
        ideia: '',
        ponte: 'E agora?',
      }),
    );
    expect(turn?.message).toBe('Reação');
    expect(turn?.bridge).toBe('E agora?');
  });

  it('sem transição, devolve texto vazio', () => {
    const turn = parseTurn(JSON.stringify({ mensagem: 'Resposta' }));
    expect(turn?.bridge).toBe('');
  });
});

describe('withoutQuestions', () => {
  it('retira só as perguntas e mantém os parágrafos', () => {
    expect(
      withoutQuestions('Socorro respira. Quem confere?\n\nO caminho foi seu.'),
    ).toBe('Socorro respira.\n\nO caminho foi seu.');
  });

  it('sem nada além da pergunta, fica vazio', () => {
    expect(withoutQuestions('Quem confere o dado?')).toBe('');
  });
});
