import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { AuthService } from '../auth/auth.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TrailService } from '../trail/trail.service';
import { GUEST_PASSWORD_HASH, InvitesService } from './invites.service';

const invite = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  companyId: 'c1',
  code: 'ABCD2345',
  revokedAt: null,
  expiresAt: null,
  maxUses: null,
  uses: 0,
  allAgents: true,
  agentIds: [],
  company: { name: 'Prefeitura' },
  ...over,
});

type GuestCreate = {
  data: { name: string; email: string; passwordHash: string };
};

const session = { token: 't', user: { companyId: 'c1' } };

function setup(found: ReturnType<typeof invite> | null) {
  const prisma = {
    orgInvite: {
      findUnique: jest.fn().mockResolvedValue(found),
      findFirst: jest
        .fn<Promise<unknown>, [{ where: { companyId: string } }]>()
        .mockResolvedValue(found),
    },
    trailEvent: {
      findFirst: jest.fn().mockResolvedValue({ companyId: 'c1' }),
      findUnique: jest.fn().mockResolvedValue({ entryOpen: true }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    user: {
      create: jest
        .fn<Promise<{ id: string }>, [GuestCreate]>()
        .mockResolvedValue({ id: 'u1' }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const assignRoom = jest.fn().mockResolvedValue(undefined);
  const service = new InvitesService(
    prisma as unknown as PrismaService,
    {} as AuthService,
    { assignRoom } as unknown as TrailService,
  );
  const accept = jest
    .spyOn(service, 'accept')
    .mockResolvedValue(session as never);
  return { prisma, service, accept, assignRoom };
}

describe('InvitesService.enterEvent', () => {
  it('entra só com o nome, na organização que abriu a entrada', async () => {
    const { prisma, service, accept, assignRoom } = setup(invite());

    await expect(service.enterEvent('Ana')).resolves.toBe(session);

    const query = prisma.orgInvite.findFirst.mock.calls[0][0];
    expect(query.where.companyId).toBe('c1');
    expect(accept).toHaveBeenCalledWith('ABCD2345', 'u1');
    expect(assignRoom).toHaveBeenCalledWith('u1', 'c1');
  });

  it('com a entrada encerrada, não cria conta', async () => {
    const { prisma, service } = setup(invite());
    prisma.trailEvent.findFirst.mockResolvedValue(null);

    await expect(service.enterEvent('Ana')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('sem convite ativo, a entrada está fechada e não cria conta', async () => {
    const { prisma, service } = setup(null);

    await expect(service.enterEvent('Ana')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('vagas esgotadas aparecem como entrada fechada', async () => {
    const { service } = setup(invite({ maxUses: 2, uses: 2 }));

    await expect(service.enterEvent('Ana')).rejects.toThrow(
      'A entrada não está aberta no momento',
    );
  });
});

describe('InvitesService.setEventEntry', () => {
  it('abrir cria o convite do evento e marca a organização', async () => {
    const { prisma, service } = setup(invite());
    prisma.trailEvent.findFirst.mockResolvedValue(null);
    const create = jest.spyOn(service, 'create').mockResolvedValue({} as never);

    await expect(service.setEventEntry('c1', 'u9', true)).resolves.toEqual({
      open: true,
    });

    expect(create).toHaveBeenCalledWith(
      'c1',
      'u9',
      expect.objectContaining({ maxUses: 300 }),
    );
    expect(prisma.trailEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { entryOpen: true } }),
    );
  });

  it('não abre se outra organização já recebe os participantes', async () => {
    const { prisma, service } = setup(invite());
    prisma.trailEvent.findFirst.mockResolvedValue({ companyId: 'outra' });

    await expect(
      service.setEventEntry('c1', 'u9', true),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.trailEvent.upsert).not.toHaveBeenCalled();
  });

  it('encerrar só fecha a entrada', async () => {
    const { prisma, service } = setup(invite());
    const create = jest.spyOn(service, 'create');

    await expect(service.setEventEntry('c1', 'u9', false)).resolves.toEqual({
      open: false,
    });

    expect(create).not.toHaveBeenCalled();
    expect(prisma.trailEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { entryOpen: false } }),
    );
  });
});

describe('InvitesService.enter', () => {
  it('coloca o convidado em uma sala ao entrar', async () => {
    const { service, assignRoom } = setup(invite());

    await service.enter('ABCD-2345', 'Ana');

    expect(assignRoom).toHaveBeenCalledWith('u1', 'c1');
  });

  it('a entrada não falha se a sala não puder ser reservada', async () => {
    const { service, assignRoom } = setup(invite());
    assignRoom.mockRejectedValue(new Error('indisponível'));

    await expect(service.enter('ABCD-2345', 'Ana')).resolves.toBe(session);
  });

  it('cria convidado sem senha e entra na organização do convite', async () => {
    const { prisma, service, accept } = setup(invite());

    await expect(service.enter('abcd-2345', 'Ana')).resolves.toBe(session);

    const { data } = prisma.user.create.mock.calls[0][0];
    expect(data.name).toBe('Ana');
    expect(data.email).toMatch(/^convidado-[0-9a-f]{16}@evento\.local$/);
    expect(data.passwordHash).toBe(GUEST_PASSWORD_HASH);
    expect(accept).toHaveBeenCalledWith('abcd-2345', 'u1');
  });

  it('nenhuma senha autentica a conta de convidado', async () => {
    await expect(
      bcrypt.compare('qualquer-senha', GUEST_PASSWORD_HASH),
    ).resolves.toBe(false);
  });

  it('código inexistente não cria conta', async () => {
    const { prisma, service } = setup(null);

    await expect(service.enter('XXXX-XXXX', 'Ana')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['revogado', { revokedAt: new Date() }],
    ['expirado', { expiresAt: new Date(Date.now() - 1000) }],
    ['esgotado', { maxUses: 2, uses: 2 }],
  ])('convite %s não cria conta', async (_nome, over) => {
    const { prisma, service } = setup(invite(over));

    await expect(service.enter('ABCD-2345', 'Ana')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('remove a conta quando o aceite falha', async () => {
    const { prisma, service, accept } = setup(invite());
    const limite = new GoneException('Este convite atingiu o limite de usos.');
    accept.mockRejectedValue(limite);

    await expect(service.enter('ABCD-2345', 'Ana')).rejects.toBe(limite);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});
