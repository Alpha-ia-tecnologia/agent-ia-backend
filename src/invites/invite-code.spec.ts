import {
  formatInviteCode,
  generateInviteCode,
  INVITE_ALPHABET,
  normalizeInviteCode,
} from './invite-code';

describe('código de convite', () => {
  it('gera 8 caracteres só do alfabeto sem ambíguos (sem 0, O, 1, I)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      for (const ch of code) expect(INVITE_ALPHABET).toContain(ch);
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it('normaliza o que a pessoa digita: caixa, espaço e hífen', () => {
    expect(normalizeInviteCode('k7p2 9qxa')).toBe('K7P29QXA');
    expect(normalizeInviteCode(' K7P2-9QXA ')).toBe('K7P29QXA');
  });

  it('formata para exibição em dois blocos', () => {
    expect(formatInviteCode('K7P29QXA')).toBe('K7P2-9QXA');
  });
});
