import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

function makeContext(user?: { role: UserRole }): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  // o guard consulta IS_PUBLIC_KEY e ROLES_KEY: cada chave tem o seu valor
  const withMetadata = (roles?: UserRole[], isPublic = false) =>
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) =>
        key === ROLES_KEY
          ? roles
          : key === IS_PUBLIC_KEY
            ? isPublic
            : undefined,
      );

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('permite quando não há roles exigidas', () => {
    withMetadata(undefined);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('permite quando o usuário tem a role exigida', () => {
    withMetadata([UserRole.OWNER, UserRole.ADMIN]);
    expect(guard.canActivate(makeContext({ role: UserRole.ADMIN }))).toBe(true);
  });

  it('bloqueia quando o usuário não tem a role exigida', () => {
    withMetadata([UserRole.OWNER]);
    expect(() =>
      guard.canActivate(makeContext({ role: UserRole.MEMBER })),
    ).toThrow(ForbiddenException);
  });

  it('bloqueia quando não há usuário na request', () => {
    withMetadata([UserRole.OWNER]);
    expect(() => guard.canActivate(makeContext())).toThrow(ForbiddenException);
  });

  it('libera rota @Public mesmo com @Roles na classe', () => {
    withMetadata([UserRole.OWNER], true);
    expect(guard.canActivate(makeContext())).toBe(true);
  });
});
