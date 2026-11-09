import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BridgeKeyGuard } from './bridge-key.guard';

function contextWith(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('BridgeKeyGuard', () => {
  const config = {
    get: jest.fn(() => 'secret-key'),
  } as unknown as ConfigService;

  it('permite requisição com x-bridge-key correta', () => {
    const guard = new BridgeKeyGuard(config);
    expect(
      guard.canActivate(contextWith({ 'x-bridge-key': 'secret-key' })),
    ).toBe(true);
  });

  it('rejeita chave incorreta', () => {
    const guard = new BridgeKeyGuard(config);
    expect(() =>
      guard.canActivate(contextWith({ 'x-bridge-key': 'errada' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejeita ausência do header', () => {
    const guard = new BridgeKeyGuard(config);
    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejeita tudo quando BRIDGE_API_KEY não está configurada', () => {
    const emptyConfig = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const guard = new BridgeKeyGuard(emptyConfig);
    expect(() =>
      guard.canActivate(contextWith({ 'x-bridge-key': '' })),
    ).toThrow(UnauthorizedException);
  });
});
