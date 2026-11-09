import type { ConfigService } from '@nestjs/config';
import { Provider } from '@prisma/client';
import type { CryptoService } from '../crypto/crypto.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ProviderKeysService } from './provider-keys.service';

const SECRET = 'sk-ant-abc123xyz987';

function setup(env: Record<string, string>) {
  return new ProviderKeysService(
    {} as PrismaService,
    {} as CryptoService,
    { get: (name: string) => env[name] } as unknown as ConfigService,
  );
}

describe('ProviderKeysService', () => {
  it('a IA usa a chave e o modelo definidos no servidor', async () => {
    const service = setup({
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_MODEL: 'modelo-do-servidor',
    });

    const key = await service.getDecrypted('c1');

    expect(key?.apiKey).toBe(SECRET);
    expect(key?.provider).toBe(Provider.ANTHROPIC);
    expect(key?.defaultModel).toBe('modelo-do-servidor');
  });

  it('sem modelo definido, usa o Haiku 5.5', async () => {
    const service = setup({ ANTHROPIC_API_KEY: SECRET });

    const key = await service.findByProvider('c1', Provider.ANTHROPIC);

    expect(key?.defaultModel).toBe('claude-haiku-5-5');
  });

  it('a listagem não expõe nenhum trecho da chave', () => {
    const service = setup({ ANTHROPIC_API_KEY: SECRET });

    const listed = service.findAll('c1');

    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(SECRET.slice(-4));
    expect(JSON.stringify(listed)).not.toContain(SECRET.slice(0, 6));
  });

  it('agente salvo com outro provedor cai na chave do servidor', async () => {
    const service = setup({ ANTHROPIC_API_KEY: SECRET });

    await expect(
      service.findByProvider('c1', Provider.OPENAI),
    ).resolves.toBeNull();
    await expect(service.getDecrypted('c1')).resolves.toMatchObject({
      apiKey: SECRET,
    });
  });

  it('sem a variável no servidor, não há chave', async () => {
    const service = setup({});

    expect(service.findAll('c1')).toEqual([]);
    await expect(service.getDecrypted('c1')).resolves.toBeNull();
  });
});
