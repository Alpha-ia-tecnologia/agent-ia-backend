import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import {
  TrailActivityService,
  type TrailAction,
} from './trail-activity.service';
import { TrailAgentsService } from './trail-agents.service';
import { TrailAiService, type ConversationInput } from './trail-ai.service';
import {
  ORCHESTRATOR_SLUG,
  specialistSeed,
  TRAIL_AGENTS,
} from './trail.agents';
import {
  SHEET_FIELDS,
  stageByNumber,
  stationByNumber,
  TRAIL_STATIONS,
  type TrailStage,
} from './trail.content';
import {
  CHEGADA,
  firstPending,
  isStation,
  LARGADA,
  MAX_ROOM_SIZE,
  MAX_STEP_ATTEMPTS,
  maxOpenStation,
  tableQuorum,
  TOTAL_STATIONS,
  winningStation,
  type PilotCandidate,
} from './trail.logic';

/** Mensagens enviadas à IA em cada volta do chat. */
const HISTORY_WINDOW = 12;
const MESSAGES_SHOWN = 60;
const MURAL_NOTES = 40;
const HIGHLIGHTS = 8;
/** Tentativas de achar lugar quando muita gente entra ao mesmo tempo. */
const ROOM_ATTEMPTS = 20;
/** Sem resposta da IA por este tempo, outra pessoa pode gerar de novo. */
const PILOT_STALE_MS = 150_000;
/** Com 300 pessoas pedindo juntas, o último plano espera cerca de 3 minutos. */
const PLAN_STALE_MS = 600_000;
const SHEET_WRITE_ATTEMPTS = 5;
const IDEA_STEP = 'ideia';

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const asJson = (value: unknown) => value as Prisma.InputJsonValue;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const runInclude = {
  results: true,
  members: {
    orderBy: { createdAt: 'asc' },
    select: {
      userId: true,
      department: true,
      user: { select: { name: true } },
    },
  },
  sessions: {
    where: { completedAt: { not: null } },
    select: { userId: true, station: true },
  },
} satisfies Prisma.TrailRunInclude;

type RunWithDetails = Prisma.TrailRunGetPayload<{
  include: typeof runInclude;
}>;

type SessionRow = Prisma.TrailSessionGetPayload<object>;
type EventFlags = { releasedUpTo: number; chegadaOpen: boolean } | null;

@Injectable()
export class TrailService {
  private readonly logger = new Logger(TrailService.name);
  private lastMessageAt = 0;
  private readonly seatQueue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: TrailAiService,
    private readonly agents: TrailAgentsService,
    private readonly activity: TrailActivityService,
  ) {}

  /** Mesas do escritório: o Guia e os especialistas. */
  async officeAgents(companyId: string) {
    await this.agents.ensure(companyId);
    const rows = await this.prisma.agent.findMany({
      where: { companyId, slug: { in: TRAIL_AGENTS.map((a) => a.slug) } },
      select: { slug: true, name: true, role: true, avatarSeed: true },
    });
    return TRAIL_AGENTS.flatMap((seed) => {
      const row = rows.find((r) => r.slug === seed.slug);
      return row ? [{ ...row, station: seed.station }] : [];
    });
  }

  /** Quem está trabalhando agora: a própria mesa ou, para o organizador, todas. */
  async activities(user: AuthUser) {
    const memberRunId =
      user.role === UserRole.MEMBER
        ? ((
            await this.prisma.trailMember.findUnique({
              where: {
                userId_companyId: {
                  userId: user.userId,
                  companyId: user.companyId,
                },
              },
              select: { runId: true },
            })
          )?.runId ?? null)
        : undefined;
    return this.activity
      .list(user.companyId, memberRunId)
      .map(({ userId, ...item }) => ({
        ...item,
        mine: userId === user.userId,
      }));
  }

  private startActivity(
    user: AuthUser,
    run: { id: string; name: string },
    station: number,
    sessionId: string,
    action: TrailAction,
  ) {
    const guide = TRAIL_AGENTS.find((a) => a.slug === ORCHESTRATOR_SLUG)!;
    return this.activity.start({
      companyId: user.companyId,
      userId: user.userId,
      runId: run.id,
      runName: run.name,
      sessionId,
      station,
      action,
      agentSlug: guide.slug,
      agentName: guide.name,
    });
  }

  stations() {
    return TRAIL_STATIONS.map((s) => ({
      number: s.number,
      title: s.title,
      tagline: s.tagline,
      question: s.question,
      challenge: s.challenge,
      care: s.care,
      specialist: specialistSeed(s.number)?.name ?? '',
    }));
  }

  private stage(n: number): TrailStage {
    const stage = stageByNumber(n);
    if (!stage) throw new NotFoundException('Estação não encontrada.');
    return stage;
  }

  private event(companyId: string) {
    return this.prisma.trailEvent.findUnique({ where: { companyId } });
  }

  private doneBy(run: RunWithDetails, station: number) {
    return run.sessions.filter((s) => s.station === station).length;
  }

  /** Visão da mesa: medalhas, participantes e andamento. */
  private runView(run: RunWithDetails, roomReleased: number) {
    const approved = run.results.map((r) => r.station).sort((a, b) => a - b);
    const first = firstPending(approved);
    return {
      id: run.id,
      number: run.number,
      name: run.name,
      capacity: MAX_ROOM_SIZE,
      members: run.members.map((m) => m.user.name),
      approved,
      current: Math.min(first, TOTAL_STATIONS),
      maxOpen: Math.min(
        TOTAL_STATIONS,
        Math.max(first, run.releasedUpTo, roomReleased),
      ),
      finished: approved.length === TOTAL_STATIONS,
      releasedUpTo: run.releasedUpTo,
    };
  }

  /** Visão da pessoa: o que ela concluiu e até onde pode ir. */
  private personalView(run: RunWithDetails, userId: string, event: EventFlags) {
    const finished = run.sessions
      .filter((s) => s.userId === userId)
      .map((s) => s.station);
    const largadaDone = finished.includes(LARGADA);
    const done = finished.filter((n) => isStation(n)).sort((a, b) => a - b);
    const first = firstPending(done);
    const allStations = first > TOTAL_STATIONS;
    return {
      largadaDone,
      done,
      current: largadaDone ? Math.min(first, TOTAL_STATIONS) : LARGADA,
      maxOpen: maxOpenStation(
        done,
        run.releasedUpTo,
        event?.releasedUpTo ?? 0,
        largadaDone,
      ),
      finished: allStations,
      chegadaOpen: largadaDone && (allStations || !!event?.chegadaOpen),
      chegadaDone: finished.includes(CHEGADA),
    };
  }

  private async myRun(user: AuthUser) {
    const member = await this.prisma.trailMember.findUnique({
      where: {
        userId_companyId: { userId: user.userId, companyId: user.companyId },
      },
      select: { run: { include: runInclude } },
    });
    return member?.run ?? null;
  }

  private async requireRun(user: AuthUser) {
    const run = await this.myRun(user);
    if (!run) {
      throw new BadRequestException('Entre em uma mesa antes de começar.');
    }
    return run;
  }

  /** Mesa da pessoa, com a garantia de que a estação está aberta para ela. */
  private async openRun(user: AuthUser, stationNumber: number) {
    const run = await this.requireRun(user);
    const event = await this.event(user.companyId);
    const me = this.personalView(run, user.userId, event);
    const open =
      stationNumber === CHEGADA ? me.chegadaOpen : stationNumber <= me.maxOpen;
    if (!open) {
      throw new ForbiddenException(
        'Conclua a estação anterior para abrir esta.',
      );
    }
    return run;
  }

  private pilotIsOpen(
    run: RunWithDetails,
    event: { pilotOpen: boolean } | null,
  ) {
    return (
      !!event?.pilotOpen ||
      run.results.some((r) => r.station === TOTAL_STATIONS)
    );
  }

  async state(user: AuthUser) {
    const [run, event] = await Promise.all([
      this.myRun(user),
      this.event(user.companyId),
    ]);
    if (!run) return { run: null, me: null, pilotOpen: false };
    const released = event?.releasedUpTo ?? 0;
    return {
      run: this.runView(run, released),
      me: this.personalView(run, user.userId, event),
      pilotOpen: this.pilotIsOpen(run, event),
    };
  }

  /**
   * Coloca a pessoa na primeira mesa com lugar, ou abre a próxima. O lugar é
   * reservado no próprio UPDATE: quem entra junto na última vaga não passa
   * do limite, porque o segundo não casa mais com a condição.
   */
  private async reserveSeat(userId: string, companyId: string): Promise<void> {
    await this.agents.ensure(companyId);
    const memberKey = { userId_companyId: { userId, companyId } };
    if (await this.prisma.trailMember.findUnique({ where: memberKey })) return;

    for (let attempt = 0; attempt < ROOM_ATTEMPTS; attempt++) {
      const room = await this.prisma.trailRun.findFirst({
        where: { companyId, memberCount: { lt: MAX_ROOM_SIZE } },
        orderBy: { number: 'asc' },
        select: { id: true },
      });
      if (!room) {
        await this.openNextRoom(companyId);
        continue;
      }
      const seat = await this.prisma.trailRun.updateMany({
        where: { id: room.id, memberCount: { lt: MAX_ROOM_SIZE } },
        data: { memberCount: { increment: 1 } },
      });
      if (seat.count === 0) continue;
      try {
        await this.prisma.trailMember.create({
          data: { runId: room.id, userId, companyId },
        });
      } catch (err) {
        // devolve o lugar; a mesma pessoa pode ter entrado em outra aba
        await this.prisma.trailRun.update({
          where: { id: room.id },
          data: { memberCount: { decrement: 1 } },
        });
        if (isUniqueViolation(err)) return;
        throw err;
      }
      return;
    }
    throw new ServiceUnavailableException(
      'Não foi possível reservar um lugar agora. Tente de novo.',
    );
  }

  /**
   * Uma reserva por vez em cada organização: com centenas de pessoas entrando
   * juntas, ninguém fica disputando a mesma vaga até esgotar as tentativas.
   */
  assignRoom(userId: string, companyId: string): Promise<void> {
    const previous = this.seatQueue.get(companyId) ?? Promise.resolve();
    const task = () => this.reserveSeat(userId, companyId);
    const current = previous.then(task, task);
    this.seatQueue.set(
      companyId,
      current.catch(() => undefined),
    );
    return current;
  }

  private async openNextRoom(companyId: string) {
    const last = await this.prisma.trailRun.aggregate({
      where: { companyId },
      _max: { number: true },
    });
    const number = (last._max.number ?? 0) + 1;
    try {
      await this.prisma.trailRun.create({
        data: { companyId, number, name: `Mesa ${number}` },
      });
    } catch (err) {
      // outra pessoa abriu esta mesa ao mesmo tempo
      if (!isUniqueViolation(err)) throw err;
    }
  }

  async join(user: AuthUser) {
    await this.assignRoom(user.userId, user.companyId);
    return this.state(user);
  }

  private opening(stage: TrailStage, name: string, tableName: string) {
    const first = stage.steps[0];
    const who = firstName(name);
    if (stage.number === LARGADA) {
      return `Olá, ${who}. Sou o Guia da Trilha da Inovação, o assistente de IA que vai apoiar você hoje.

Você está na ${tableName}. Cada pessoa conversa comigo no próprio celular, e as ideias de vocês formam o piloto de 90 dias da mesa.

${first.ask}`;
    }
    if (stage.number === CHEGADA) {
      return `${who}, agora é a sua vez de levar a trilha para o seu trabalho.

Com 1 dor, 1 dado e 1 dono da sua área, monto o seu plano de ação para os próximos 90 dias.

${first.ask}`;
    }
    return `${who}, chegamos à Estação ${stage.number} de ${TOTAL_STATIONS}: ${stage.title}.

${stage.scene} **${stage.question}**

Passo 1, ${first.title}. ${first.ask}`;
  }

  /** Abre a conversa da pessoa nesta estação na primeira visita. */
  private async ensureSession(
    run: RunWithDetails,
    stage: TrailStage,
    user: AuthUser,
  ): Promise<SessionRow> {
    const where = {
      runId_userId_station: {
        runId: run.id,
        userId: user.userId,
        station: stage.number,
      },
    };
    const existing = await this.prisma.trailSession.findUnique({ where });
    if (existing) return existing;
    try {
      const created = await this.prisma.trailSession.create({
        data: {
          runId: run.id,
          userId: user.userId,
          station: stage.number,
          options: asJson(stage.steps[0].options),
        },
      });
      const agents = await this.agents.load(user.companyId);
      await this.say(
        created.id,
        'assistant',
        agents.orchestrator.name,
        this.opening(stage, this.member(run, user.userId).name, run.name),
      );
      return created;
    } catch (err) {
      // a mesma pessoa abriu em duas abas ao mesmo tempo
      if (!isUniqueViolation(err)) throw err;
      return this.prisma.trailSession.findUniqueOrThrow({ where });
    }
  }

  private say(
    sessionId: string,
    role: 'assistant' | 'user' | 'event',
    authorName: string,
    content: string,
  ) {
    // duas mensagens no mesmo milissegundo não podem trocar de ordem na tela
    this.lastMessageAt = Math.max(Date.now(), this.lastMessageAt + 1);
    return this.prisma.trailMessage.create({
      data: {
        sessionId,
        role,
        authorName,
        content,
        createdAt: new Date(this.lastMessageAt),
      },
    });
  }

  /** Evita duas ações ao mesmo tempo na mesma conversa. */
  private assertFree(sessionId: string) {
    if (this.activity.busy(sessionId)) {
      throw new ConflictException('O Guia ainda está respondendo.');
    }
  }

  private member(run: RunWithDetails, userId: string) {
    const member = run.members.find((m) => m.userId === userId);
    return {
      name: member?.user.name ?? 'Participante',
      department: member?.department ?? null,
    };
  }

  private tableProgress(run: RunWithDetails, station: number) {
    const memberCount = run.members.length;
    return {
      name: run.name,
      doneCount: this.doneBy(run, station),
      memberCount,
      quorum: tableQuorum(memberCount),
      medal: run.results.some((r) => r.station === station),
    };
  }

  /** Tudo o que a tela da conversa mostra; cada pessoa vê só a sua. */
  async session(user: AuthUser, stationNumber: number) {
    const stage = this.stage(stationNumber);
    const run = await this.openRun(user, stationNumber);
    const session = await this.ensureSession(run, stage, user);
    const [rows, idea] = await Promise.all([
      this.prisma.trailMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'desc' },
        take: MESSAGES_SHOWN,
      }),
      this.prisma.trailNote.findUnique({
        where: {
          runId_userId_station_step: {
            runId: run.id,
            userId: user.userId,
            station: stationNumber,
            step: IDEA_STEP,
          },
        },
        select: { text: true },
      }),
    ]);
    const document = stage.documents.find((d) => d.id === session.documentId);
    const finished = session.phase === 'done';
    return {
      stage: {
        number: stage.number,
        title: stage.title,
        question: stage.question,
        care: stage.care,
        material: stage.material,
        capabilities: stage.capabilities,
      },
      steps: stage.steps.map((s, i) => ({
        key: s.key,
        title: s.title,
        minutes: s.minutes,
        status:
          finished || i < session.stepIndex
            ? 'done'
            : i === session.stepIndex
              ? 'current'
              : 'pending',
      })),
      phase: session.phase,
      attachLabel: stage.attachLabel,
      documents:
        session.phase === 'attach'
          ? stage.documents.map(({ id, title, subtitle }) => ({
              id,
              title,
              subtitle,
            }))
          : [],
      document: document
        ? { title: document.title, text: document.text }
        : null,
      startPrompt: stage.startPrompt,
      options: session.options as unknown as string[],
      busy: this.activity.busy(session.id),
      completed: !!session.completedAt,
      idea: idea?.text ?? null,
      table: this.tableProgress(run, stationNumber),
      messages: rows.reverse().map((m) => ({
        id: m.id,
        role: m.role,
        authorName: m.authorName,
        content: m.content,
      })),
    };
  }

  /** Quem da mesa está em cada ponto, e o que já foi anotado. */
  async mural(user: AuthUser, stationNumber: number) {
    const stage = this.stage(stationNumber);
    const run = await this.openRun(user, stationNumber);
    const [sessions, notes] = await Promise.all([
      this.prisma.trailSession.findMany({
        where: { runId: run.id, station: stationNumber },
        select: { userId: true, stepIndex: true, phase: true },
      }),
      this.prisma.trailNote.findMany({
        where: { runId: run.id, station: stationNumber },
        orderBy: { createdAt: 'desc' },
        take: MURAL_NOTES,
      }),
    ]);
    const labelOf = (key: string) =>
      key === IDEA_STEP
        ? 'Ideia da estação'
        : (stage.steps.find((s) => s.key === key)?.title ?? key);
    return {
      table: this.tableProgress(run, stationNumber),
      people: run.members.map((m) => {
        const session = sessions.find((s) => s.userId === m.userId);
        return {
          name: m.user.name,
          department: m.department,
          mine: m.userId === user.userId,
          status: !session
            ? 'waiting'
            : session.phase === 'done'
              ? 'done'
              : 'active',
          step: session
            ? (stage.steps[session.stepIndex]?.title ?? null)
            : null,
        };
      }),
      notes: notes.map((n) => ({
        id: n.id,
        authorName: n.authorName,
        department: n.department,
        label: labelOf(n.step),
        isIdea: n.step === IDEA_STEP,
        text: n.text,
      })),
    };
  }

  /** A pessoa anexa o documento e o especialista assume o passo. */
  async attach(user: AuthUser, stationNumber: number, documentId: string) {
    const stage = this.stage(stationNumber);
    const document = stage.documents.find((d) => d.id === documentId);
    if (!document) throw new NotFoundException('Documento não encontrado.');
    const run = await this.openRun(user, stationNumber);
    const session = await this.ensureSession(run, stage, user);
    this.assertFree(session.id);
    const claimed = await this.prisma.trailSession.updateMany({
      where: { id: session.id, phase: 'attach' },
      data: { phase: 'prompt', documentId, options: asJson([]) },
    });
    if (claimed.count > 0) {
      const member = this.member(run, user.userId);
      const agents = await this.agents.load(user.companyId);
      await this.say(
        session.id,
        'event',
        member.name,
        `Você anexou ${document.title}`,
      );
      await this.say(
        session.id,
        'assistant',
        agents.specialistFor(stationNumber).name,
        `Recebi o documento, ${firstName(member.name)}. Neste passo trabalho com você. Deixei abaixo o prompt de partida da estação: ajuste o que quiser e envie.`,
      );
    }
    return this.session(user, stationNumber);
  }

  private saveNote(
    run: RunWithDetails,
    user: AuthUser,
    station: number,
    step: string,
    text: string,
  ) {
    const { name, department } = this.member(run, user.userId);
    const data = { authorName: name, department, text };
    return this.prisma.trailNote.upsert({
      where: {
        runId_userId_station_step: {
          runId: run.id,
          userId: user.userId,
          station,
          step,
        },
      },
      create: { runId: run.id, userId: user.userId, station, step, ...data },
      update: data,
    });
  }

  /** Secretaria da Largada: resposta guardada direto, sem consultar a IA. */
  private async answerScripted(
    run: RunWithDetails,
    stage: TrailStage,
    session: SessionRow,
    user: AuthUser,
    content: string,
  ) {
    const step = stage.steps[session.stepIndex];
    const next = stage.steps[session.stepIndex + 1];
    const claimed = await this.prisma.trailSession.updateMany({
      where: { id: session.id, stepIndex: session.stepIndex },
      data: next
        ? {
            stepIndex: session.stepIndex + 1,
            attempts: 0,
            options: asJson(next.options),
          }
        : {
            phase: 'done',
            attempts: 0,
            options: asJson([]),
            completedAt: new Date(),
          },
    });
    if (claimed.count === 0) return;
    await this.prisma.trailMember.update({
      where: {
        userId_companyId: { userId: user.userId, companyId: user.companyId },
      },
      data: { department: content.slice(0, 80) },
    });
    const agents = await this.agents.load(user.companyId);
    await this.say(
      session.id,
      'user',
      this.member(run, user.userId).name,
      content,
    );
    await this.say(
      session.id,
      'assistant',
      agents.orchestrator.name,
      next ? `Obrigado. ${next.ask}` : (step.closing ?? 'Obrigado.'),
    );
  }

  /** A mesa ganha a medalha quando metade dela conclui a estação. */
  private async awardMedal(runId: string, station: number) {
    const [done, members] = await Promise.all([
      this.prisma.trailSession.count({
        where: { runId, station, completedAt: { not: null } },
      }),
      this.prisma.trailMember.count({ where: { runId } }),
    ]);
    if (done < tableQuorum(members)) return;
    try {
      await this.prisma.trailResult.create({ data: { runId, station } });
    } catch (err) {
      // outra pessoa concluiu ao mesmo tempo
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /** A pessoa responde e o Guia conduz o próximo passo. */
  async answer(user: AuthUser, stationNumber: number, content: string) {
    const stage = this.stage(stationNumber);
    const run = await this.openRun(user, stationNumber);
    const session = await this.ensureSession(run, stage, user);
    if (session.phase !== 'answer' && session.phase !== 'prompt') {
      throw new BadRequestException('Esta etapa não está aguardando resposta.');
    }
    this.assertFree(session.id);
    const step = stage.steps[session.stepIndex];
    if (step.scripted) {
      await this.answerScripted(run, stage, session, user, content);
      return this.session(user, stationNumber);
    }

    const isPrompt = session.phase === 'prompt';
    const isQuestion = content.includes('?');
    const lastAttempt =
      !isPrompt && !isQuestion && session.attempts + 1 >= MAX_STEP_ATTEMPTS;
    const { id: activityId } = this.startActivity(
      user,
      run,
      stationNumber,
      session.id,
      isPrompt ? 'analysis' : 'turn',
    );
    const member = this.member(run, user.userId);
    const sent = await this.say(session.id, 'user', member.name, content);
    let result:
      | Awaited<ReturnType<TrailAiService['turn']>>
      | Awaited<ReturnType<TrailAiService['solve']>>;
    try {
      const earlier = await this.prisma.trailMessage.findMany({
        where: { sessionId: session.id, id: { not: sent.id } },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_WINDOW - 1,
      });
      const ideas =
        stationNumber === CHEGADA
          ? await this.prisma.trailNote.findMany({
              where: { runId: run.id, userId: user.userId, step: IDEA_STEP },
              orderBy: { station: 'asc' },
              select: { text: true },
            })
          : [];
      const input: ConversationInput = {
        stage,
        person: { ...member, ideas: ideas.map((i) => i.text) },
        tableName: run.name,
        document:
          stage.documents.find((d) => d.id === session.documentId) ?? null,
        step,
        next: stage.steps[session.stepIndex + 1] ?? null,
        history: [...earlier.reverse(), sent],
        lastAttempt,
      };
      const assign = (agent: { slug: string; name: string }) =>
        this.activity.assign(activityId, agent);
      result = isPrompt
        ? await this.ai.solve(user.companyId, input, assign)
        : await this.ai.turn(user.companyId, input, assign);
      this.activity.finish(activityId);
    } catch (err) {
      this.activity.remove(activityId);
      // sem resposta: o texto volta para o campo e pode ser reenviado
      await this.prisma.trailMessage.delete({ where: { id: sent.id } });
      throw err;
    }

    if ('text' in result) {
      await this.say(session.id, 'assistant', result.agentName, result.text);
      await this.prisma.trailSession.update({
        where: { id: session.id },
        data: { phase: 'answer', attempts: 0, options: asJson(result.options) },
      });
      return this.session(user, stationNumber);
    }

    await this.say(session.id, 'assistant', result.agentName, result.message);
    if (!result.counted) {
      await this.prisma.trailSession.update({
        where: { id: session.id },
        data: { options: asJson([]) },
      });
      return this.session(user, stationNumber);
    }

    if (!result.resolved && !lastAttempt) {
      await this.prisma.trailSession.update({
        where: { id: session.id },
        data: {
          attempts: isQuestion ? session.attempts : session.attempts + 1,
          options: asJson(result.options),
        },
      });
      return this.session(user, stationNumber);
    }

    await this.saveNote(
      run,
      user,
      stationNumber,
      step.key,
      result.note || content.slice(0, 120),
    );
    const next = stage.steps[session.stepIndex + 1];
    if (next) {
      await this.prisma.trailSession.update({
        where: { id: session.id },
        data: {
          stepIndex: session.stepIndex + 1,
          attempts: 0,
          phase: next.attach ? 'attach' : 'answer',
          options: asJson(
            next.attach
              ? []
              : result.options.length
                ? result.options
                : next.options,
          ),
        },
      });
      return this.session(user, stationNumber);
    }

    if (isStation(stationNumber)) {
      await this.saveNote(
        run,
        user,
        stationNumber,
        IDEA_STEP,
        result.idea || result.note || content.slice(0, 200),
      );
    }
    await this.prisma.trailSession.update({
      where: { id: session.id },
      data: {
        phase: 'done',
        attempts: 0,
        options: asJson([]),
        completedAt: new Date(),
      },
    });
    if (isStation(stationNumber)) await this.awardMedal(run.id, stationNumber);
    return this.session(user, stationNumber);
  }

  private async pilotRow(runId: string) {
    return this.prisma.trailPilot.findUnique({
      where: { runId },
      include: { votes: true },
    });
  }

  /** Escolha do piloto e Ficha, vistas por toda a mesa. */
  async pilot(user: AuthUser) {
    const run = await this.requireRun(user);
    const [event, row] = await Promise.all([
      this.event(user.companyId),
      this.pilotRow(run.id),
    ]);
    const candidates = (row?.candidates ?? []) as unknown as PilotCandidate[];
    const votes = row?.votes ?? [];
    const memberCount = run.members.length;
    const quorum = tableQuorum(memberCount);
    const chosen = candidates.find((c) => c.station === row?.chosen) ?? null;
    const sheet = (row?.sheet ?? {}) as Record<string, string>;
    return {
      open: this.pilotIsOpen(run, event),
      status: row?.status ?? 'none',
      table: this.tableProgress(run, TOTAL_STATIONS),
      voteQuorum: quorum,
      voters: votes.length,
      myVote: votes.find((v) => v.userId === user.userId)?.station ?? null,
      candidates: candidates.map((c) => ({
        ...c,
        stationTitle: stationByNumber(c.station)?.title ?? '',
        votes: votes.filter((v) => v.station === c.station).length,
      })),
      chosen,
      sheet: SHEET_FIELDS.map((f) => ({
        key: f.key,
        label: f.label,
        hint: f.hint,
        value: sheet[f.key] ?? '',
      })),
    };
  }

  /** O primeiro a chegar dispara o Guia; os demais acompanham pelo status. */
  async startPilot(user: AuthUser) {
    const run = await this.requireRun(user);
    const event = await this.event(user.companyId);
    if (!this.pilotIsOpen(run, event)) {
      throw new ForbiddenException('A escolha do piloto ainda não abriu.');
    }
    await this.prisma.trailPilot.deleteMany({
      where: {
        runId: run.id,
        status: 'generating',
        updatedAt: { lt: new Date(Date.now() - PILOT_STALE_MS) },
      },
    });
    try {
      await this.prisma.trailPilot.create({
        data: { runId: run.id, status: 'generating' },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return this.pilot(user);
    }
    try {
      const notes = await this.prisma.trailNote.findMany({
        where: { runId: run.id, step: IDEA_STEP },
        orderBy: { createdAt: 'asc' },
      });
      const ideas = TRAIL_STATIONS.flatMap((s) => {
        const texts = notes
          .filter((n) => n.station === s.number)
          .map((n) => n.text);
        return texts.length
          ? [{ station: s.number, title: s.title, notes: texts }]
          : [];
      });
      if (ideas.length === 0) {
        throw new BadRequestException(
          'Sua mesa ainda não anotou nenhuma ideia.',
        );
      }
      const candidates = await this.ai.candidates(user.companyId, {
        tableName: run.name,
        ideas,
      });
      await this.prisma.trailPilot.update({
        where: { runId: run.id },
        data: { status: 'voting', candidates: asJson(candidates) },
      });
    } catch (err) {
      await this.prisma.trailPilot.deleteMany({ where: { runId: run.id } });
      throw err;
    }
    return this.pilot(user);
  }

  async votePilot(user: AuthUser, station: number) {
    const run = await this.requireRun(user);
    const row = await this.pilotRow(run.id);
    const candidates = (row?.candidates ?? []) as unknown as PilotCandidate[];
    if (
      row?.status !== 'voting' ||
      !candidates.some((c) => c.station === station)
    ) {
      throw new BadRequestException('Esta escolha não está aberta.');
    }
    await this.prisma.trailPilotVote.upsert({
      where: { runId_userId: { runId: run.id, userId: user.userId } },
      create: { runId: run.id, userId: user.userId, station },
      update: { station },
    });
    return this.pilot(user);
  }

  /** Fecha a escolha e o Guia monta a Ficha do Piloto da ideia vencedora. */
  async closePilot(user: AuthUser) {
    const run = await this.requireRun(user);
    const row = await this.pilotRow(run.id);
    if (row?.status !== 'voting') return this.pilot(user);
    const candidates = row.candidates as unknown as PilotCandidate[];
    if (row.votes.length < tableQuorum(run.members.length)) {
      throw new BadRequestException(
        'Falta metade da mesa votar para fechar a escolha.',
      );
    }
    const chosen = winningStation(
      row.votes.map((v) => v.station),
      candidates.map((c) => c.station),
    );
    const idea = candidates.find((c) => c.station === chosen);
    if (!idea) throw new BadRequestException('Nenhuma ideia recebeu votos.');
    const claimed = await this.prisma.trailPilot.updateMany({
      where: { runId: run.id, status: 'voting' },
      data: { status: 'drafting', chosen: idea.station },
    });
    if (claimed.count === 0) return this.pilot(user);
    try {
      const notes = await this.prisma.trailNote.findMany({
        where: { runId: run.id, station: idea.station },
        orderBy: { createdAt: 'asc' },
      });
      const line = (n: (typeof notes)[number]) =>
        `${n.step}${n.department ? ` (${n.department})` : ''}: ${n.text}`;
      const station = stationByNumber(idea.station);
      const sheet = await this.ai.sheet(user.companyId, {
        tableName: run.name,
        stationTitle: station?.title ?? '',
        challenge: station?.challenge ?? '',
        capabilities: station?.capabilities ?? [],
        idea,
        notes: notes.map(line),
      });
      await this.prisma.trailPilot.update({
        where: { runId: run.id },
        data: { status: 'ready', sheet: asJson(sheet) },
      });
    } catch (err) {
      await this.prisma.trailPilot.updateMany({
        where: { runId: run.id },
        data: { status: 'voting', chosen: null },
      });
      throw err;
    }
    return this.pilot(user);
  }

  /** A mesa revisa a ficha; a escrita condicional evita perder edições simultâneas. */
  async editSheet(user: AuthUser, field: string, value: string) {
    if (!SHEET_FIELDS.some((f) => f.key === field)) {
      throw new BadRequestException('Campo inválido.');
    }
    const run = await this.requireRun(user);
    for (let attempt = 0; attempt < SHEET_WRITE_ATTEMPTS; attempt++) {
      const row = await this.pilotRow(run.id);
      if (row?.status !== 'ready') {
        throw new BadRequestException('A ficha ainda não está pronta.');
      }
      const sheet = row.sheet as Record<string, string>;
      const saved = await this.prisma.trailPilot.updateMany({
        where: { runId: run.id, updatedAt: row.updatedAt },
        data: { sheet: asJson({ ...sheet, [field]: value }) },
      });
      if (saved.count > 0) return this.pilot(user);
    }
    throw new ConflictException('Outra pessoa editou agora. Tente de novo.');
  }

  private pilotTitle(row: { chosen: number | null; candidates: unknown }) {
    const candidates = row.candidates as PilotCandidate[];
    return candidates.find((c) => c.station === row.chosen) ?? null;
  }

  /** Votação final: pilotos prontos das outras mesas. */
  async publicVote(user: AuthUser) {
    const run = await this.requireRun(user);
    const [event, pilots, mine] = await Promise.all([
      this.event(user.companyId),
      this.prisma.trailPilot.findMany({
        where: {
          status: 'ready',
          run: { companyId: user.companyId, id: { not: run.id } },
        },
        include: { run: { select: { id: true, name: true, number: true } } },
        orderBy: { run: { number: 'asc' } },
      }),
      this.prisma.trailPublicVote.findUnique({
        where: {
          companyId_userId: {
            companyId: user.companyId,
            userId: user.userId,
          },
        },
      }),
    ]);
    return {
      open: !!event?.voteOpen,
      myVote: mine?.runId ?? null,
      options: pilots.map((p) => {
        const idea = this.pilotTitle(p);
        return {
          runId: p.run.id,
          name: p.run.name,
          title: idea?.title ?? '',
          summary: idea?.summary ?? '',
        };
      }),
    };
  }

  async castPublicVote(user: AuthUser, runId: string) {
    const run = await this.requireRun(user);
    const event = await this.event(user.companyId);
    if (!event?.voteOpen) {
      throw new BadRequestException('A votação não está aberta.');
    }
    if (runId === run.id) {
      throw new BadRequestException('Vote em um piloto de outra mesa.');
    }
    const target = await this.prisma.trailPilot.findFirst({
      where: { runId, status: 'ready', run: { companyId: user.companyId } },
      select: { runId: true },
    });
    if (!target) throw new NotFoundException('Piloto não encontrado.');
    await this.prisma.trailPublicVote.upsert({
      where: {
        companyId_userId: { companyId: user.companyId, userId: user.userId },
      },
      create: { companyId: user.companyId, userId: user.userId, runId },
      update: { runId },
    });
    return this.publicVote(user);
  }

  /** Plano de 90 dias da própria pessoa. */
  async plan(user: AuthUser) {
    const run = await this.requireRun(user);
    const [event, row] = await Promise.all([
      this.event(user.companyId),
      this.prisma.trailPlan.findUnique({
        where: { runId_userId: { runId: run.id, userId: user.userId } },
      }),
    ]);
    // processo interrompido no meio: a pessoa pode pedir de novo
    const stale =
      row?.status === 'generating' &&
      row.updatedAt.getTime() < Date.now() - PLAN_STALE_MS;
    const member = this.member(run, user.userId);
    return {
      status: stale ? 'failed' : (row?.status ?? 'none'),
      chegadaDone: this.personalView(run, user.userId, event).chegadaDone,
      name: member.name,
      department: member.department,
      tableName: run.name,
      plan: row?.status === 'ready' ? row.content : null,
    };
  }

  /** Reserva o plano e devolve na hora: a IA trabalha em segundo plano. */
  async startPlan(user: AuthUser) {
    const run = await this.requireRun(user);
    const event = await this.event(user.companyId);
    if (!this.personalView(run, user.userId, event).chegadaDone) {
      throw new ForbiddenException('Conclua a Chegada para montar o plano.');
    }
    const owner = { runId: run.id, userId: user.userId };
    const session = await this.prisma.trailSession.findUniqueOrThrow({
      where: { runId_userId_station: { ...owner, station: CHEGADA } },
      select: { id: true },
    });
    await this.prisma.trailPlan.deleteMany({
      where: {
        ...owner,
        OR: [
          { status: 'failed' },
          {
            status: 'generating',
            updatedAt: { lt: new Date(Date.now() - PLAN_STALE_MS) },
          },
        ],
      },
    });
    try {
      await this.prisma.trailPlan.create({
        data: { ...owner, status: 'generating' },
      });
    } catch (err) {
      // a mesma pessoa pediu em duas abas ao mesmo tempo
      if (!isUniqueViolation(err)) throw err;
      return this.plan(user);
    }
    void this.generatePlan(user, run, session.id);
    return this.plan(user);
  }

  private async generatePlan(
    user: AuthUser,
    run: RunWithDetails,
    sessionId: string,
  ) {
    const owner = { runId: run.id, userId: user.userId };
    const { id: activityId } = this.startActivity(
      user,
      run,
      CHEGADA,
      sessionId,
      'plan',
    );
    try {
      const [notes, conversation, pilot] = await Promise.all([
        this.prisma.trailNote.findMany({
          where: owner,
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.trailMessage.findMany({
          where: { sessionId },
          orderBy: { createdAt: 'asc' },
        }),
        this.pilotRow(run.id),
      ]);
      const chosen = pilot?.status === 'ready' ? this.pilotTitle(pilot) : null;
      const content = await this.ai.plan(
        user.companyId,
        {
          person: this.member(run, user.userId),
          tableName: run.name,
          conversation,
          stations: TRAIL_STATIONS.flatMap((s) => {
            const mine = notes.filter((n) => n.station === s.number);
            return mine.length
              ? [
                  {
                    number: s.number,
                    title: s.title,
                    notes: mine.map((n) => `${n.step}: ${n.text}`),
                  },
                ]
              : [];
          }),
          pilot: chosen,
        },
        (agent) => this.activity.assign(activityId, agent),
      );
      await this.prisma.trailPlan.updateMany({
        where: owner,
        data: { status: 'ready', content: asJson(content) },
      });
      this.activity.finish(activityId);
    } catch (err) {
      this.activity.remove(activityId);
      this.logger.warn(`Plano não gerado: ${(err as Error).message}`);
      await this.prisma.trailPlan
        .updateMany({ where: owner, data: { status: 'failed' } })
        .catch(() => undefined);
    }
  }

  async board(companyId: string) {
    await this.agents.ensure(companyId);
    const [runs, event, aiReady, pilots, votes, ideas, plans] =
      await Promise.all([
        this.prisma.trailRun.findMany({
          where: { companyId, members: { some: {} } },
          orderBy: { number: 'asc' },
          include: runInclude,
        }),
        this.event(companyId),
        this.ai.ready(companyId),
        this.prisma.trailPilot.findMany({
          where: { run: { companyId } },
        }),
        this.prisma.trailPublicVote.groupBy({
          by: ['runId'],
          where: { companyId },
          _count: { _all: true },
        }),
        this.prisma.trailNote.findMany({
          where: { step: IDEA_STEP, run: { companyId } },
          orderBy: { createdAt: 'desc' },
          take: HIGHLIGHTS,
          include: { run: { select: { name: true } } },
        }),
        this.prisma.trailPlan.count({
          where: { status: 'ready', run: { companyId } },
        }),
      ]);
    const released = event?.releasedUpTo ?? 0;
    return {
      releasedUpTo: released,
      pilotOpen: !!event?.pilotOpen,
      voteOpen: !!event?.voteOpen,
      chegadaOpen: !!event?.chegadaOpen,
      plansReady: plans,
      aiReady,
      highlights: ideas.map((n) => ({
        id: n.id,
        runName: n.run.name,
        authorName: n.authorName,
        department: n.department,
        station: n.station,
        text: n.text,
      })),
      runs: runs.map((run) => {
        const pilot = pilots.find((p) => p.runId === run.id);
        return {
          ...this.runView(run, released),
          peopleAt: run.members.map(
            (m) => this.personalView(run, m.userId, event).current,
          ),
          doneByStation: TRAIL_STATIONS.map((s) => this.doneBy(run, s.number)),
          chegadaDone: this.doneBy(run, CHEGADA),
          pilotStatus: pilot?.status ?? 'none',
          pilotTitle: pilot ? (this.pilotTitle(pilot)?.title ?? null) : null,
          publicVotes: votes.find((v) => v.runId === run.id)?._count._all ?? 0,
        };
      }),
    };
  }

  /** Fichas de todas as mesas, para a SEMISPE reunir e imprimir. */
  async pilots(companyId: string) {
    const rows = await this.prisma.trailPilot.findMany({
      where: { status: 'ready', run: { companyId } },
      include: { run: { select: { name: true, number: true } } },
      orderBy: { run: { number: 'asc' } },
    });
    return rows.map((p) => {
      const sheet = p.sheet as Record<string, string>;
      return {
        runId: p.runId,
        name: p.run.name,
        title: this.pilotTitle(p)?.title ?? '',
        sheet: SHEET_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          hint: f.hint,
          value: sheet[f.key] ?? '',
        })),
      };
    });
  }

  private setEventFlag(
    companyId: string,
    data: {
      releasedUpTo?: number;
      pilotOpen?: boolean;
      voteOpen?: boolean;
      chegadaOpen?: boolean;
    },
  ) {
    return this.prisma.trailEvent.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });
  }

  async releaseRoom(companyId: string, upTo: number) {
    await this.setEventFlag(companyId, { releasedUpTo: upTo });
    return this.board(companyId);
  }

  async setPilotOpen(companyId: string, open: boolean) {
    await this.setEventFlag(companyId, { pilotOpen: open });
    return this.board(companyId);
  }

  async setVoteOpen(companyId: string, open: boolean) {
    await this.setEventFlag(companyId, { voteOpen: open });
    return this.board(companyId);
  }

  async setChegadaOpen(companyId: string, open: boolean) {
    await this.setEventFlag(companyId, { chegadaOpen: open });
    return this.board(companyId);
  }

  async releaseRun(companyId: string, runId: string, upTo: number) {
    const res = await this.prisma.trailRun.updateMany({
      where: { id: runId, companyId },
      data: { releasedUpTo: upTo },
    });
    if (res.count === 0) {
      throw new NotFoundException('Mesa não encontrada.');
    }
    return this.board(companyId);
  }
}
