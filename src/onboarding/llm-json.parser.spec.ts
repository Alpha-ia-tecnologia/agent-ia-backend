import { parseAgentsJson } from './llm-json.parser';

const VALID = {
  agents: [
    {
      name: 'Sofia',
      role: 'Analista Financeira',
      department: 'Financeiro',
      systemPrompt: 'Você é a Sofia...',
      avatarSeed: 'sofia-financeiro',
    },
    {
      name: 'Ricardo',
      role: 'Especialista de Marketing',
      department: 'Marketing',
      systemPrompt: 'Você é o Ricardo...',
      avatarSeed: 'ricardo-marketing',
    },
  ],
};

describe('parseAgentsJson', () => {
  it('parseia JSON puro', () => {
    const agents = parseAgentsJson(JSON.stringify(VALID));
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe('Sofia');
    expect(agents[1].department).toBe('Marketing');
  });

  it('parseia resposta com markdown fence ```json', () => {
    const raw =
      'Claro! Aqui está o escritório sugerido:\n\n```json\n' +
      JSON.stringify(VALID, null, 2) +
      '\n```\n\nEspero que goste!';
    const agents = parseAgentsJson(raw);
    expect(agents).toHaveLength(2);
    expect(agents[1].name).toBe('Ricardo');
  });

  it('parseia JSON embutido em prosa sem fence', () => {
    const raw = 'Segue a resposta: ' + JSON.stringify(VALID) + ' — fim.';
    const agents = parseAgentsJson(raw);
    expect(agents).toHaveLength(2);
  });

  it('gera avatarSeed a partir do nome quando ausente', () => {
    const raw = JSON.stringify({
      agents: [
        {
          name: 'Ana Paula',
          role: 'RH',
          department: 'Pessoas',
          systemPrompt: 'x',
        },
      ],
    });
    expect(parseAgentsJson(raw)[0].avatarSeed).toBe('ana-paula');
  });

  it('lança erro para resposta vazia', () => {
    expect(() => parseAgentsJson('')).toThrow(/vazia/i);
  });

  it('lança erro quando não há JSON', () => {
    expect(() => parseAgentsJson('desculpe, não consigo ajudar')).toThrow();
  });

  it('lança erro quando falta a lista agents', () => {
    expect(() => parseAgentsJson('{"foo": 1}')).toThrow(/agents/);
  });

  it('lança erro para agente sem nome', () => {
    expect(() => parseAgentsJson('{"agents": [{"role": "x"}]}')).toThrow(
      /sem nome/,
    );
  });
});
