import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { CryptoService } from './crypto.service';

function makeService(keyHex?: string) {
  const key = keyHex ?? randomBytes(32).toString('hex');
  const config = {
    getOrThrow: jest.fn().mockReturnValue(key),
  } as unknown as ConfigService;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  it('roundtrip: decrypt(encrypt(x)) === x', () => {
    const service = makeService();
    const secret = 'sk-super-secret-api-key-1234567890';
    const payload = service.encrypt(secret);
    expect(payload.encrypted).not.toContain(secret);
    expect(service.decrypt(payload)).toBe(secret);
  });

  it('gera iv diferente a cada chamada', () => {
    const service = makeService();
    const a = service.encrypt('mesmo-texto');
    const b = service.encrypt('mesmo-texto');
    expect(a.iv).not.toBe(b.iv);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('falha ao adulterar o ciphertext (authTag)', () => {
    const service = makeService();
    const payload = service.encrypt('dados');
    const tampered = {
      ...payload,
      encrypted: Buffer.from('xxxx').toString('base64'),
    };
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('rejeita chave-mestra com tamanho errado', () => {
    expect(() => makeService('abcd')).toThrow(/32 bytes/);
  });
});
