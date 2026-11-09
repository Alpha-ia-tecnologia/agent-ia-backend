import { TrailActivityService } from './trail-activity.service';

const base = {
  companyId: 'c1',
  runId: 'r1',
  runName: 'Mesa 1',
  sessionId: 's1',
  userId: 'u1',
  station: 1,
  action: 'turn' as const,
  agentSlug: 'orquestrador',
  agentName: 'Orquestrador',
};

describe('TrailActivityService', () => {
  afterEach(() => jest.useRealTimers());

  it('passa do orquestrador para o especialista', () => {
    const service = new TrailActivityService();
    const { id } = service.start(base);
    expect(service.list('c1')[0]).toMatchObject({
      phase: 'routing',
      agentSlug: 'orquestrador',
    });

    service.assign(id, { slug: 'acessibilidade', name: 'Especialista' });

    expect(service.list('c1')[0]).toMatchObject({
      phase: 'working',
      agentSlug: 'acessibilidade',
    });
  });

  it('participante vê só a própria mesa; organizador vê todas', () => {
    const service = new TrailActivityService();
    service.start(base);
    service.start({ ...base, runId: 'r2', runName: 'Mesa 2' });

    expect(service.list('c1', 'r1')).toHaveLength(1);
    expect(service.list('c1')).toHaveLength(2);
    expect(service.list('c1', null)).toHaveLength(0);
    expect(service.list('outra')).toHaveLength(0);
  });

  it('a entrega concluída some depois de alguns segundos', () => {
    jest.useFakeTimers();
    const service = new TrailActivityService();
    const { id } = service.start(base);
    service.finish(id);
    expect(service.list('c1')[0].phase).toBe('done');

    jest.advanceTimersByTime(3_500);

    expect(service.list('c1')).toHaveLength(0);
  });

  it('ação interrompida não fica presa no escritório', () => {
    jest.useFakeTimers();
    const service = new TrailActivityService();
    service.start(base);

    jest.advanceTimersByTime(200_000);

    expect(service.list('c1')).toHaveLength(0);
  });

  it('cada conversa fica ocupada de forma independente', () => {
    const service = new TrailActivityService();
    const { id } = service.start(base);
    service.start({ ...base, sessionId: 's2', userId: 'u2' });

    expect(service.busy('s1')).toBe(true);
    expect(service.busy('s2')).toBe(true);
    expect(service.busy('s3')).toBe(false);

    service.finish(id);

    expect(service.busy('s1')).toBe(false);
    expect(service.busy('s2')).toBe(true);
  });
});
