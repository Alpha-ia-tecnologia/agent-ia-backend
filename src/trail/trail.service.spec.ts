import type { PrismaService } from '../prisma/prisma.service';
import { TrailActivityService } from './trail-activity.service';
import type { TrailAgentsService } from './trail-agents.service';
import type { TrailAiService } from './trail-ai.service';
import { MAX_ROOM_SIZE } from './trail.logic';
import { TrailService } from './trail.service';

interface Room {
  id: string;
  number: number;
  memberCount: number;
}

/** Banco mínimo em memória, com as mesmas condições que o serviço usa. */
function setup(initial: Room[] = []) {
  const rooms = [...initial];
  const members = new Map<string, string>();
  const prisma = {
    trailMember: {
      findUnique: jest.fn(
        ({ where }: { where: { userId_companyId: { userId: string } } }) =>
          Promise.resolve(
            members.has(where.userId_companyId.userId) ? { id: 'm' } : null,
          ),
      ),
      create: jest.fn(
        ({ data }: { data: { userId: string; runId: string } }) => {
          members.set(data.userId, data.runId);
          return Promise.resolve({ id: 'm' });
        },
      ),
    },
    trailRun: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          [...rooms]
            .sort((a, b) => a.number - b.number)
            .find((r) => r.memberCount < MAX_ROOM_SIZE) ?? null,
        ),
      ),
      updateMany: jest.fn(({ where }: { where: { id: string } }) => {
        const room = rooms.find(
          (r) => r.id === where.id && r.memberCount < MAX_ROOM_SIZE,
        );
        if (room) room.memberCount += 1;
        return Promise.resolve({ count: room ? 1 : 0 });
      }),
      aggregate: jest.fn(() =>
        Promise.resolve({
          _max: {
            number: rooms.length
              ? Math.max(...rooms.map((r) => r.number))
              : null,
          },
        }),
      ),
      create: jest.fn(({ data }: { data: { number: number } }) => {
        const room = {
          id: `r${data.number}`,
          number: data.number,
          memberCount: 0,
        };
        rooms.push(room);
        return Promise.resolve(room);
      }),
    },
  };
  const service = new TrailService(
    prisma as unknown as PrismaService,
    {} as TrailAiService,
    {
      ensure: jest.fn().mockResolvedValue(undefined),
    } as unknown as TrailAgentsService,
    new TrailActivityService(),
  );
  return { service, rooms, members };
}

describe('TrailService.assignRoom', () => {
  it('abre a primeira sala para a primeira pessoa', async () => {
    const { service, rooms, members } = setup();

    await service.assignRoom('u1', 'c1');

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ number: 1, memberCount: 1 });
    expect(members.get('u1')).toBe('r1');
  });

  it('não coloca mais de 11 pessoas na mesma sala', async () => {
    const { service, rooms, members } = setup();

    for (let i = 1; i <= 12; i++) await service.assignRoom(`u${i}`, 'c1');

    expect(rooms.map((r) => r.memberCount)).toEqual([11, 1]);
    expect(members.get('u11')).toBe('r1');
    expect(members.get('u12')).toBe('r2');
  });

  it('mantém o limite com muitas pessoas entrando ao mesmo tempo', async () => {
    const { service, rooms, members } = setup();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) => service.assignRoom(`u${i}`, 'c1')),
    );

    expect(members.size).toBe(50);
    expect(rooms.every((r) => r.memberCount <= MAX_ROOM_SIZE)).toBe(true);
    expect(rooms.reduce((sum, r) => sum + r.memberCount, 0)).toBe(50);
  });

  it('quem já tem sala não ocupa outro lugar', async () => {
    const { service, rooms } = setup();

    await service.assignRoom('u1', 'c1');
    await service.assignRoom('u1', 'c1');

    expect(rooms[0].memberCount).toBe(1);
  });

  it('completa uma sala com vaga antes de abrir outra', async () => {
    const { service, rooms, members } = setup([
      { id: 'r1', number: 1, memberCount: MAX_ROOM_SIZE },
      { id: 'r2', number: 2, memberCount: 3 },
    ]);

    await service.assignRoom('u1', 'c1');

    expect(members.get('u1')).toBe('r2');
    expect(rooms).toHaveLength(2);
  });
});
