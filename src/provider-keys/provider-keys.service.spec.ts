import { maskKey, normalizeBaseUrl } from './provider-keys.service';

describe('maskKey', () => {
  it('mascara chaves longas mantendo início e fim', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-...cdef');
  });

  it('mascara totalmente chaves curtas', () => {
    expect(maskKey('12345678')).toBe('****');
  });
});

describe('normalizeBaseUrl', () => {
  it('remove sufixos de endpoints colados', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions')).toBe(
      'https://api.x.com/v1',
    );
    expect(normalizeBaseUrl('https://api.x.com/v1/models')).toBe(
      'https://api.x.com/v1',
    );
  });

  it('remove barras finais', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1///')).toBe(
      'https://api.x.com/v1',
    );
  });
});
