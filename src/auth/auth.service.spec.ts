/* eslint-disable @typescript-eslint/require-await -- mocks do teste */
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

async function makeService() {
  const passwordHash = await bcrypt.hash('certa', 4);
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        companyId: 'c1',
        role: 'OWNER',
        email: 'ana@x.com',
        name: 'Ana',
        passwordHash,
        company: { name: 'X', onboardingStatus: 'COMPLETED' },
      }),
      // sessão: organização ativa vem dos vínculos
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'ana@x.com',
        name: 'Ana',
        companyId: 'c1',
        memberships: [
          {
            role: 'OWNER',
            company: { id: 'c1', name: 'X', onboardingStatus: 'COMPLETED' },
          },
        ],
      }),
    },
  } as unknown as PrismaService;
  const jwt = {
    sign: jest.fn().mockReturnValue('tok'),
  } as unknown as JwtService;
  const config = { get: () => undefined } as unknown as ConfigService;
  return new AuthService(prisma, jwt, config);
}

/** Redis falso compartilhado: simula réplicas da api olhando o mesmo contador. */
function fakeRedis() {
  const store = new Map<string, number>();
  return {
    status: 'ready',
    get: jest.fn(async (k: string) => store.get(k)?.toString() ?? null),
    incr: jest.fn(async (k: string) => {
      store.set(k, (store.get(k) ?? 0) + 1);
      return store.get(k)!;
    }),
    pexpire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

describe('AuthService login — limite por e-mail', () => {
  it('bloqueia o e-mail após 10 erros, sem afetar outro e-mail', async () => {
    const service = await makeService();
    for (let i = 0; i < 10; i++) {
      await expect(
        service.login({ email: 'ana@x.com', password: 'errada' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // bloqueado mesmo com a senha certa (e sem diferenciar maiúsculas)
    await expect(
      service.login({ email: 'ANA@x.com', password: 'certa' }),
    ).rejects.toMatchObject({ status: 429 });
    // outro e-mail (mesmo IP no evento) segue livre
    await expect(
      service.login({ email: 'bia@x.com', password: 'certa' }),
    ).resolves.toHaveProperty('token', 'tok');
  });

  it('login certo zera os erros', async () => {
    const service = await makeService();
    for (let i = 0; i < 9; i++) {
      await service
        .login({ email: 'ana@x.com', password: 'errada' })
        .catch(() => undefined);
    }
    await service.login({ email: 'ana@x.com', password: 'certa' });
    for (let i = 0; i < 9; i++) {
      await service
        .login({ email: 'ana@x.com', password: 'errada' })
        .catch(() => undefined);
    }
    await expect(
      service.login({ email: 'ana@x.com', password: 'certa' }),
    ).resolves.not.toBeInstanceOf(HttpException);
  });

  it('com Redis, o limite vale entre réplicas da api', async () => {
    const redis = fakeRedis();
    const replicaA = await makeService();
    const replicaB = await makeService();
    Object.assign(replicaA, { redis });
    Object.assign(replicaB, { redis });
    for (let i = 0; i < 10; i++) {
      const replica = i % 2 ? replicaA : replicaB;
      await replica
        .login({ email: 'ana@x.com', password: 'errada' })
        .catch(() => undefined);
    }
    await expect(
      replicaA.login({ email: 'ana@x.com', password: 'certa' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(redis.pexpire).toHaveBeenCalledTimes(1);
  });

  it('Redis fora do ar não trava o login (cai para a memória)', async () => {
    const service = await makeService();
    const broken = {
      status: 'ready',
      get: jest.fn(async () => {
        throw new Error('down');
      }),
      incr: jest.fn(async () => {
        throw new Error('down');
      }),
      pexpire: jest.fn(),
      del: jest.fn(async () => {
        throw new Error('down');
      }),
    };
    Object.assign(service, { redis: broken });
    await expect(
      service.login({ email: 'ana@x.com', password: 'certa' }),
    ).resolves.toHaveProperty('token', 'tok');
  });
});
