import { BadRequestException, ConflictException } from '@nestjs/common';
import { MeetingsService } from './meetings.service';

const MEET_URL = 'https://meet.google.com/abc-defg-hij';

function makeService(
  prismaOverrides: Record<string, unknown> = {},
  botAccountsOverrides: Record<string, unknown> = {},
) {
  const prisma = {
    channel: {
      findFirst: jest.fn().mockResolvedValue({ id: 'ch1', config: {} }),
      findUnique: jest.fn().mockResolvedValue({ id: 'ch1', config: {} }),
    },
    meetingSession: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'm1' }),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    ...prismaOverrides,
  } as unknown as ConstructorParameters<typeof MeetingsService>[0];
  const queue = {
    enqueueBotJob: jest.fn().mockResolvedValue(undefined),
  } as never;
  const storage = {} as never;
  const cfg = {
    maxConcurrentPerCompany: 5,
    defaultBotName: 'Assistente AAO (gravando)',
    defaultConsentMessage: 'aviso padrão',
  } as never;
  const botAccounts = {
    requireForPlatform: jest.fn().mockResolvedValue('acc1'),
    findConnected: jest.fn().mockResolvedValue({ id: 'acc1' }),
    ...botAccountsOverrides,
  } as never;
  return {
    service: new MeetingsService(prisma, queue, storage, cfg, botAccounts),
    prisma: prisma as unknown as {
      channel: { findFirst: jest.Mock; findUnique: jest.Mock };
      meetingSession: {
        count: jest.Mock;
        create: jest.Mock;
        findUnique: jest.Mock;
        update: jest.Mock;
      };
    },
    queue: queue as unknown as { enqueueBotJob: jest.Mock },
  };
}

describe('MeetingsService.createMeeting', () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();

  it('rejeita links que não são Teams nem Meet', async () => {
    const { service } = makeService();
    await expect(
      service.createMeeting('c1', { joinUrl: 'https://zoom.us/j/1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige a conta do escritório conectada (gating) para a plataforma', async () => {
    const { service } = makeService(
      {},
      {
        requireForPlatform: jest
          .fn()
          .mockRejectedValue(new BadRequestException('Conecte a conta Google')),
      },
    );
    await expect(
      service.createMeeting('c1', { joinUrl: MEET_URL }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige um canal de reuniões configurado', async () => {
    const { service } = makeService({
      channel: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
      },
    });
    await expect(
      service.createMeeting('c1', { joinUrl: MEET_URL }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('respeita o teto de reuniões simultâneas por empresa', async () => {
    const { service } = makeService({
      meetingSession: {
        count: jest.fn().mockResolvedValue(5),
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    });
    await expect(
      service.createMeeting('c1', { joinUrl: MEET_URL }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('agenda sem enfileirar quando scheduledAt está no futuro', async () => {
    const { service, queue } = makeService();
    const res = await service.createMeeting('c1', {
      joinUrl: MEET_URL,
      scheduledAt: future,
    });
    expect(res).toEqual({ id: 'm1' });
    expect(queue.enqueueBotJob).not.toHaveBeenCalled();
  });

  it('enfileira imediato com nome do bot e aviso de consentimento derivados', async () => {
    const session = {
      id: 'm1',
      companyId: 'c1',
      channelId: 'ch1',
      joinUrl: MEET_URL,
      platform: 'MEET',
    };
    const { service, queue } = makeService({
      meetingSession: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue(session),
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await service.createMeeting('c1', { joinUrl: MEET_URL });
    expect(queue.enqueueBotJob).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingSessionId: 'm1',
        platform: 'MEET',
        guestName: 'Assistente AAO (gravando)',
        announce: 'aviso padrão',
      }),
    );
  });
});
