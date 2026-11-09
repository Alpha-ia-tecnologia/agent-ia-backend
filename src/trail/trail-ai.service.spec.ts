import type { ConfigService } from '@nestjs/config';
import type { ProviderKeysService } from '../provider-keys/provider-keys.service';
import type { TrailAgentsService } from './trail-agents.service';
import { TrailAiService } from './trail-ai.service';

function setup(
  env: Record<string, string | undefined>,
  stored: { apiKey: string } | null = null,
) {
  const findByProvider = jest.fn().mockResolvedValue(stored);
  const service = new TrailAiService(
    { findByProvider } as unknown as ProviderKeysService,
    {} as TrailAgentsService,
    { get: (name: string) => env[name] } as unknown as ConfigService,
  );
  return { service, findByProvider };
}

describe('TrailAiService.ready', () => {
  it('usa a chave do .env sem consultar a de Configurações', async () => {
    const { service, findByProvider } = setup({
      ANTHROPIC_API_KEY: 'sk-ant-x',
    });

    await expect(service.ready('c1')).resolves.toBe(true);
    expect(findByProvider).not.toHaveBeenCalled();
  });

  it('com o .env em branco, usa a chave de Configurações', async () => {
    const { service, findByProvider } = setup(
      { ANTHROPIC_API_KEY: '   ' },
      { apiKey: 'sk-ant-y' },
    );

    await expect(service.ready('c1')).resolves.toBe(true);
    expect(findByProvider).toHaveBeenCalled();
  });

  it('sem nenhuma chave, a IA não fica pronta', async () => {
    const { service } = setup({ ANTHROPIC_API_KEY: '' });

    await expect(service.ready('c1')).resolves.toBe(false);
  });
});
