/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- mocks do teste */
import { ConversationStreamService } from './conversation-stream.service';
import {
  ConversationsService,
  friendlyChatError,
  isProviderFailureText,
} from './conversations.service';
import type { BridgeEvent } from './bridge.service';

/**
 * A web recarrega as mensagens ao receber final_message: ele só pode sair
 * depois da resposta gravada, e nunca para uma falha de provedor que a chave
 * reserva ainda vai refazer.
 */
function makeService(attempts: BridgeEvent[][]) {
  const order: string[] = [];
  const stream = new ConversationStreamService();
  const emit = stream.emit.bind(stream);
  stream.emit = (id: string, ev: BridgeEvent) => {
    order.push(`emit:${ev.type}`);
    emit(id, ev);
  };
  let call = 0;
  const used: string[] = [];
  const bridge = {
    async *chat(req: { provider: { provider: string } }) {
      used.push(req.provider.provider);
      for (const ev of attempts[call++] ?? []) yield ev;
    },
  };
  const prisma = {
    message: {
      create: jest.fn(async () => {
        order.push('db:message');
      }),
    },
    conversation: { update: jest.fn(async () => undefined) },
    orchestrationEvent: { create: jest.fn(async () => undefined) },
    tokenUsage: { create: jest.fn(async () => undefined) },
  };
  const drain = { drainPending: jest.fn(async () => []) };
  const service = new (ConversationsService as any)(
    prisma,
    {},
    { deliver: jest.fn(async () => undefined) },
    drain,
    drain,
    bridge,
    stream,
    {},
    {},
    {},
    {},
    { get: () => undefined },
  );
  return { service, order, prisma, used };
}

const request = {
  tenant_id: 'c1',
  provider: { provider: 'openai', model: 'm', api_key: 'k' },
} as any;

describe('ConversationsService — ordem do final_message', () => {
  it('emite final_message só depois de gravar a resposta', async () => {
    const { service, order } = makeService([
      [
        { type: 'token_chunk', text: 'Olá' },
        { type: 'final_message', text: 'Olá' },
      ],
    ]);
    await service.consumeBridge('conv1', 'a1', request);
    expect(order).toEqual([
      'emit:token_chunk',
      'db:message',
      'emit:final_message',
    ]);
  });

  it('falha de provedor com reserva não encerra o stream da web', async () => {
    const backup = { provider: 'deepseek', model: 'd', api_key: 'k2' };
    const { service, order, prisma } = makeService([
      [{ type: 'final_message', text: 'API call failed after 3 retries' }],
      [{ type: 'final_message', text: 'Resposta da reserva' }],
    ]);
    await service.consumeBridge('conv1', 'a1', request, undefined, [
      request.provider,
      backup,
    ]);
    // um único final_message (o da reserva), depois de gravado
    expect(order.filter((o) => o === 'emit:final_message')).toHaveLength(1);
    expect(order.at(-1)).toBe('emit:final_message');
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['resposta vazia', [{ type: 'final_message', text: '' }]],
    ['stream que acaba sem final', [{ type: 'token_chunk', text: 'Ol' }]],
  ])('%s vira erro visível', async (_, events) => {
    const { service, order } = makeService([events as BridgeEvent[]]);
    await service.consumeBridge('conv1', 'a1', request);
    expect(order.at(-1)).toBe('emit:error');
  });

  it('erro do bridge chega à web traduzido', () => {
    expect(
      friendlyChatError(
        "session/resume: {'details': 'No LLM provider configured.'}",
      ),
    ).toMatch(/Nenhum provedor de IA/);
    expect(friendlyChatError('algo estranho')).toMatch(/Tente de novo/);
  });

  it('erro de provedor aciona a reserva e o caído vai para o fim', async () => {
    const backup = { provider: 'deepseek', model: 'd', api_key: 'k2' };
    const chain = [{ ...request.provider, api_key: 'k-caida' }, backup];
    const { service, order, used } = makeService([
      [
        { type: 'token_chunk', text: 'meio texto' },
        { type: 'error', text: 'Error code: 429 - rate limit' },
      ],
      [{ type: 'final_message', text: 'Resposta da reserva' }],
      [{ type: 'final_message', text: 'Segunda mensagem' }],
    ]);
    await service.consumeBridge('conv1', 'a1', request, undefined, chain);
    expect(order).not.toContain('emit:error');
    expect(order).toContain('emit:agent_status'); // restart: web limpa o texto
    expect(order.at(-1)).toBe('emit:final_message');
    // próxima mensagem já começa pela reserva (o principal caiu há pouco)
    await service.consumeBridge('conv2', 'a1', request, undefined, chain);
    expect(used).toEqual(['openai', 'deepseek', 'deepseek']);
  });

  it('resposta longa citando 429 não é tratada como falha', () => {
    expect(
      isProviderFailureText('Erro 429 é limite de requisições. '.repeat(20)),
    ).toBe(false);
    expect(isProviderFailureText('API call failed after 3 retries: 529')).toBe(
      true,
    );
  });
});
