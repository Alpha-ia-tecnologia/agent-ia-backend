import { CustomTool } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { ToolExecutorService } from './tool-executor.service';

describe('ToolExecutorService', () => {
  let service: ToolExecutorService;
  let fetchMock: jest.Mock;

  const crypto = {
    decrypt: jest.fn(() => JSON.stringify({ Authorization: 'Bearer abc' })),
  } as unknown as CryptoService;

  const baseTool: CustomTool = {
    id: 't1',
    companyId: 'c1',
    name: 'cadastrar_usuario',
    displayName: 'Cadastrar usuário',
    description: 'Cadastra usuário',
    method: 'POST',
    url: 'https://api.exemplo.com/users',
    encryptedHeaders: 'enc',
    headersIv: 'iv',
    headersAuthTag: 'tag',
    paramsSchema: { type: 'object', properties: {} },
    timeoutMs: 15000,
    isActive: true,
    createdAt: new Date(),
  };

  beforeEach(() => {
    service = new ToolExecutorService(crypto);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('retorna ok com corpo truncado a 4000 chars em sucesso', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('x'.repeat(5000)),
    });
    const result = await service.execute(baseTool, { nome: 'Ana' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body!.length).toBeLessThanOrEqual(4000 + 20);
    expect(result.body).toContain('[truncado]');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(baseTool.url);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ nome: 'Ana' }));
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer abc',
    );
  });

  it('para GET envia args como query params sem body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ok'),
    });
    const tool = { ...baseTool, method: 'GET' as const };
    await service.execute(tool, { q: 'ana', page: 2 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.exemplo.com/users?q=ana&page=2');
    expect(init.body).toBeUndefined();
  });

  it('transforma HTTP 500 em erro descritivo em português sem lançar', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });
    const result = await service.execute(baseTool, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain('HTTP 500');
    expect(result.error).toContain('erro no servidor de destino');
  });

  it('transforma timeout em erro descritivo sem lançar', async () => {
    const timeoutError = new Error('operation timed out');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);
    const result = await service.execute(baseTool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tempo limite');
    expect(result.error).toContain('15000ms');
  });

  it('transforma falha de rede em erro descritivo sem lançar', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await service.execute(baseTool, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Falha de rede');
  });
});
