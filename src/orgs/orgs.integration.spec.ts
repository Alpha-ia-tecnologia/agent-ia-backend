/* eslint-disable @typescript-eslint/no-unsafe-argument -- fixtures do teste (ator fake) */
/**
 * Contas e organizações contra um Postgres de verdade (vínculos, transações e
 * unicidade são justamente o que se testa aqui). Roda só com
 * TEST_DATABASE_URL (banco descartável, migrations aplicadas):
 *   TEST_DATABASE_URL=postgresql://aao:aao@localhost:55432/aao npx jest orgs.integration
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { OrgGuard } from '../auth/guards/org.guard';
import { forgetMembership } from '../auth/membership-cache';
import { NO_ORG_KEY } from '../auth/decorators/no-org.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from './orgs.service';
import { InvitesService } from '../invites/invites.service';
import { UsersService } from '../users/users.service';
import { AgentsService } from '../agents/agents.service';
import { pickDefaultAgent } from '../agents/agent-access';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { GoneException, NotFoundException } from '@nestjs/common';

const dbUrl = process.env.TEST_DATABASE_URL;
const describeDb = dbUrl ? describe : describe.skip;

const uid = () => randomBytes(4).toString('hex');
const email = (who: string) => `${who}-${uid()}@teste.aao`;

describeDb('Contas e organizações (Postgres real)', () => {
  let prisma: PrismaService;
  let auth: AuthService;
  let orgs: OrgsService;
  let jwt: JwtService;
  let invites: InvitesService;
  let users: UsersService;
  let agents: AgentsService;

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    jwt = new JwtService({ secret: 'segredo-de-teste' });
    const config = { get: () => undefined } as unknown as ConfigService;
    auth = new AuthService(prisma, jwt, config);
    orgs = new OrgsService(prisma, auth);
    invites = new InvitesService(prisma, auth);
    users = new UsersService(prisma);
    agents = new AgentsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const payloadOf = (token: string) =>
    jwt.verify<{ companyId: string | null; role: string | null }>(token);

  describe('autenticação com organização ativa', () => {
    it('cadastro com nome de empresa cria a org e entra como dono', async () => {
      const res = await auth.signup({
        name: 'Ana',
        email: email('ana'),
        password: 'senha-forte',
        companyName: 'Empresa da Ana',
      });
      expect(res.user.companyId).toBeTruthy();
      expect(res.user.role).toBe('OWNER');
      expect(res.orgs).toHaveLength(1);
      expect(payloadOf(res.token).companyId).toBe(res.user.companyId);
    });

    it('cadastro sem nome de empresa cria só a conta, sem organização', async () => {
      const before = await prisma.company.count();
      const res = await auth.signup({
        name: 'Bia',
        email: email('bia'),
        password: 'senha-forte',
      });
      expect(await prisma.company.count()).toBe(before);
      expect(res.user.companyId).toBeNull();
      expect(res.orgs).toEqual([]);
      expect(payloadOf(res.token).companyId).toBeNull();
    });

    it('login entra na última organização usada', async () => {
      const mail = email('caio');
      const first = await auth.signup({
        name: 'Caio',
        email: mail,
        password: 'senha-forte',
        companyName: 'Primeira',
      });
      const second = await orgs.create(first.user.id, { name: 'Segunda' });
      expect(second.user.companyName).toBe('Segunda');
      const res = await auth.login({ email: mail, password: 'senha-forte' });
      expect(res.user.companyName).toBe('Segunda');
      expect(res.orgs.map((o) => o.name).sort()).toEqual([
        'Primeira',
        'Segunda',
      ]);
    });

    it('trocar para uma organização da qual não faz parte é proibido', async () => {
      const dono = await auth.signup({
        name: 'Dani',
        email: email('dani'),
        password: 'senha-forte',
        companyName: 'Da Dani',
      });
      const outro = await auth.signup({
        name: 'Edu',
        email: email('edu'),
        password: 'senha-forte',
      });
      await expect(
        auth.switchOrg(outro.user.id, dono.user.companyId!),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('OrgGuard', () => {
    const ctx = (user: unknown, noOrg = false): ExecutionContext => {
      const handler = () => undefined;
      if (noOrg) Reflect.defineMetadata(NO_ORG_KEY, true, handler);
      return {
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      } as unknown as ExecutionContext;
    };

    it('bloqueia rota normal sem organização ativa e libera rota @NoOrg()', async () => {
      const guard = new OrgGuard(new Reflector(), prisma);
      const semOrg = { userId: 'x', companyId: null, role: null };
      await expect(guard.canActivate(ctx(semOrg))).rejects.toThrow(
        'Entre em uma organização ou crie a sua.',
      );
      await expect(guard.canActivate(ctx(semOrg, true))).resolves.toBe(true);
    });

    it('bloqueia quem foi removido da organização, mesmo com o token antigo', async () => {
      const dono = await auth.signup({
        name: 'Fabi',
        email: email('fabi'),
        password: 'senha-forte',
        companyName: 'Da Fabi',
      });
      const guard = new OrgGuard(new Reflector(), prisma);
      const user = {
        userId: dono.user.id,
        companyId: dono.user.companyId,
        role: 'OWNER',
      };
      await expect(guard.canActivate(ctx({ ...user }))).resolves.toBe(true);
      // remoção direta no banco: invalida o cache como o serviço faz
      await prisma.membership.deleteMany({ where: { userId: dono.user.id } });
      forgetMembership(dono.user.id, dono.user.companyId!);
      const fresh = new OrgGuard(new Reflector(), prisma);
      await expect(fresh.canActivate(ctx({ ...user }))).rejects.toThrow(
        'Você não faz mais parte desta organização.',
      );
    });

    it('promoção e remoção valem na hora, mesmo com o papel em cache', async () => {
      const dono = await auth.signup({
        name: 'Hugo',
        email: email('hugo'),
        password: 'senha-forte',
        companyName: 'Do Hugo',
      });
      const companyId = dono.user.companyId!;
      const inv = await invites.create(companyId, dono.user.id, {});
      const membro = await auth.signup({
        name: 'Iris',
        email: email('iris'),
        password: 'senha-forte',
      });
      await invites.accept(inv.code, membro.user.id);
      const guard = new OrgGuard(new Reflector(), prisma);
      const req = () => ({ userId: membro.user.id, companyId, role: 'MEMBER' });
      const first = req();
      await guard.canActivate(ctx(first)); // põe MEMBER no cache
      expect(first.role).toBe('MEMBER');
      const owner = {
        userId: dono.user.id,
        companyId,
        role: 'OWNER',
        email: 'x',
      };
      await users.update(companyId, owner as any, membro.user.id, {
        role: 'ADMIN',
      });
      const second = req();
      await guard.canActivate(ctx(second));
      expect(second.role).toBe('ADMIN');
      await users.remove(companyId, owner as any, membro.user.id);
      await expect(guard.canActivate(ctx(req()))).rejects.toThrow(
        'Você não faz mais parte desta organização.',
      );
    });

    it('atualiza o papel do token com o papel atual do vínculo', async () => {
      const dono = await auth.signup({
        name: 'Gil',
        email: email('gil'),
        password: 'senha-forte',
        companyName: 'Do Gil',
      });
      await prisma.membership.updateMany({
        where: { userId: dono.user.id },
        data: { role: 'ADMIN' },
      });
      const guard = new OrgGuard(new Reflector(), prisma);
      const user = {
        userId: dono.user.id,
        companyId: dono.user.companyId,
        role: 'OWNER',
      };
      await guard.canActivate(ctx(user));
      expect(user.role).toBe('ADMIN');
    });
  });

  describe('convites', () => {
    const novaOrg = async () => {
      const dono = await auth.signup({
        name: 'Dono',
        email: email('dono'),
        password: 'senha-forte',
        companyName: `Org ${uid()}`,
      });
      return { dono, companyId: dono.user.companyId! };
    };
    const novaConta = async () =>
      auth.signup({
        name: 'Pessoa',
        email: email('p'),
        password: 'senha-forte',
      });

    it('quem aceita entra como membro e a sessão já vem na org', async () => {
      const { dono, companyId } = await novaOrg();
      const inv = await invites.create(companyId, dono.user.id, {});
      const pessoa = await novaConta();
      const prev = await invites.preview(inv.code.toLowerCase());
      expect(prev.companyName).toBe(dono.user.companyName);
      const res = await invites.accept(inv.code, pessoa.user.id);
      expect(res.user.companyId).toBe(companyId);
      expect(res.user.role).toBe('MEMBER');
    });

    it('aceitar duas vezes não duplica o vínculo nem gasta outro uso', async () => {
      const { dono, companyId } = await novaOrg();
      const inv = await invites.create(companyId, dono.user.id, {});
      const pessoa = await novaConta();
      await invites.accept(inv.code, pessoa.user.id);
      await invites.accept(inv.code, pessoa.user.id);
      expect(
        await prisma.membership.count({
          where: { userId: pessoa.user.id, companyId },
        }),
      ).toBe(1);
      const after = await prisma.orgInvite.findUniqueOrThrow({
        where: { id: inv.id },
      });
      expect(after.uses).toBe(1);
    });

    it('quem já é membro entra mesmo com o convite esgotado ou vencido (QR reescaneado)', async () => {
      const { dono, companyId } = await novaOrg();
      const inv = await invites.create(companyId, dono.user.id, { maxUses: 1 });
      const pessoa = await novaConta();
      await invites.accept(inv.code, pessoa.user.id); // gasta o único uso
      const again = await invites.accept(inv.code, pessoa.user.id);
      expect(again.user.companyId).toBe(companyId);
      await prisma.orgInvite.update({
        where: { id: inv.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await invites.accept(inv.code, pessoa.user.id);
      expect(expired.user.companyId).toBe(companyId);
      // quem não é membro continua barrado
      const outra = await novaConta();
      await expect(
        invites.accept(inv.code, outra.user.id),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('código inexistente dá 404; revogado e vencido dão 410', async () => {
      const { dono, companyId } = await novaOrg();
      await expect(invites.preview('ZZZZZZZZ')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const revogado = await invites.create(companyId, dono.user.id, {});
      await invites.revoke(companyId, revogado.id);
      await expect(invites.preview(revogado.code)).rejects.toBeInstanceOf(
        GoneException,
      );
      const vencido = await invites.create(companyId, dono.user.id, {});
      await prisma.orgInvite.update({
        where: { id: vencido.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const pessoa = await novaConta();
      await expect(
        invites.accept(vencido.code, pessoa.user.id),
      ).rejects.toBeInstanceOf(GoneException);
    });

    it('limite de 1 uso: o segundo aceite (pessoa diferente) é recusado', async () => {
      const { dono, companyId } = await novaOrg();
      const inv = await invites.create(companyId, dono.user.id, { maxUses: 1 });
      const a = await novaConta();
      const b = await novaConta();
      const results = await Promise.allSettled([
        invites.accept(inv.code, a.user.id),
        invites.accept(inv.code, b.user.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        GoneException,
      );
      expect(await prisma.membership.count({ where: { companyId } })).toBe(2);
    });
  });

  describe('membros e papéis', () => {
    /** org com dono + um membro entrando por convite */
    const orgComMembro = async () => {
      const dono = await auth.signup({
        name: 'Dono',
        email: email('dono'),
        password: 'senha-forte',
        companyName: `Org ${uid()}`,
      });
      const companyId = dono.user.companyId!;
      const inv = await invites.create(companyId, dono.user.id, {});
      const membro = await auth.signup({
        name: 'Membro',
        email: email('m'),
        password: 'senha-forte',
      });
      await invites.accept(inv.code, membro.user.id);
      const actor = (u: { user: { id: string } }, role: string) => ({
        userId: u.user.id,
        companyId,
        role,
        email: 'x',
      });
      return { dono, membro, companyId, actor };
    };

    it('lista os membros da org pelos vínculos, com o papel de cada um', async () => {
      const { companyId } = await orgComMembro();
      const list = await users.findAll(companyId);
      expect(list.map((u) => u.role).sort()).toEqual(['MEMBER', 'OWNER']);
    });

    it('só o dono promove: dono promove membro a admin; admin não mexe em papel', async () => {
      const { dono, membro, companyId, actor } = await orgComMembro();
      const res = await users.update(
        companyId,
        actor(dono, 'OWNER') as any,
        membro.user.id,
        { role: 'ADMIN' },
      );
      expect(res.role).toBe('ADMIN');
      await expect(
        users.update(companyId, actor(membro, 'ADMIN') as any, dono.user.id, {
          role: 'MEMBER',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        users.update(companyId, actor(membro, 'ADMIN') as any, membro.user.id, {
          role: 'MEMBER',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ninguém vira dono por edição de papel', async () => {
      const { dono, membro, companyId, actor } = await orgComMembro();
      await expect(
        users.update(companyId, actor(dono, 'OWNER') as any, membro.user.id, {
          role: 'OWNER',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin não remove outro admin; o dono remove', async () => {
      const { dono, membro, companyId, actor } = await orgComMembro();
      await users.update(
        companyId,
        actor(dono, 'OWNER') as any,
        membro.user.id,
        {
          role: 'ADMIN',
        },
      );
      const inv = await invites.create(companyId, dono.user.id, {});
      const outro = await auth.signup({
        name: 'Outro',
        email: email('outro'),
        password: 'senha-forte',
      });
      await invites.accept(inv.code, outro.user.id);
      await users.update(
        companyId,
        actor(dono, 'OWNER') as any,
        outro.user.id,
        {
          role: 'ADMIN',
        },
      );
      await expect(
        users.remove(companyId, actor(membro, 'ADMIN') as any, outro.user.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await users.remove(companyId, actor(dono, 'OWNER') as any, outro.user.id);
      expect(
        await prisma.membership.count({
          where: { userId: outro.user.id, companyId },
        }),
      ).toBe(0);
    });

    it('remover tira o vínculo e mantém a conta; o dono não sai', async () => {
      const { dono, membro, companyId, actor } = await orgComMembro();
      await users.remove(
        companyId,
        actor(dono, 'OWNER') as any,
        membro.user.id,
      );
      expect(
        await prisma.membership.count({
          where: { userId: membro.user.id, companyId },
        }),
      ).toBe(0);
      expect(await prisma.user.count({ where: { id: membro.user.id } })).toBe(
        1,
      );
      await expect(
        users.remove(companyId, actor(dono, 'OWNER') as any, dono.user.id),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('"adicionar funcionário" com e-mail que já tem conta só cria o vínculo', async () => {
      const { dono, companyId, actor } = await orgComMembro();
      const outra = await auth.signup({
        name: 'Outra',
        email: email('outra'),
        password: 'senha-forte',
      });
      const res = await users.invite(
        companyId,
        actor(dono, 'OWNER') as any,
        'X',
        outra.user.email,
      );
      expect(res.temporaryPassword).toBeNull();
      expect(
        await prisma.membership.count({
          where: { userId: outra.user.id, companyId },
        }),
      ).toBe(1);
      await expect(
        users.invite(
          companyId,
          actor(dono, 'OWNER') as any,
          'X',
          outra.user.email,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('acesso a agentes numa org não apaga o acesso em outra org', async () => {
      const a = await orgComMembro();
      const b = await orgComMembro();
      // o mesmo membro entra também na org B
      const invB = await invites.create(b.companyId, b.dono.user.id, {});
      await invites.accept(invB.code, a.membro.user.id);
      const agA = await prisma.agent.create({
        data: {
          name: 'AgA',
          slug: `a-${uid()}`,
          avatarSeed: 'a',
          companyId: a.companyId,
        },
      });
      const agB = await prisma.agent.create({
        data: {
          name: 'AgB',
          slug: `b-${uid()}`,
          avatarSeed: 'b',
          companyId: b.companyId,
        },
      });
      await users.setAgentAccess(a.companyId, a.membro.user.id, [agA.id]);
      await users.setAgentAccess(b.companyId, a.membro.user.id, [agB.id]);
      expect(await users.getAgentAccess(a.companyId, a.membro.user.id)).toEqual(
        [agA.id],
      );
    });
  });

  describe('acesso aos agentes definido no convite', () => {
    /** org com Gerente + 2 especialistas; devolve ids e um criador de convidados */
    const orgComAgentes = async () => {
      const dono = await auth.signup({
        name: 'Dono',
        email: email('dono'),
        password: 'senha-forte',
        companyName: `Org ${uid()}`,
      });
      const companyId = dono.user.companyId!;
      const mk = (name: string, isManager = false) =>
        prisma.agent.create({
          data: {
            name,
            slug: `${name}-${uid()}`,
            avatarSeed: 'x',
            companyId,
            isManager,
          },
        });
      const gerente = await mk('Gerente', true);
      const vendas = await mk('Vendas');
      const juridico = await mk('Juridico');
      const entrar = async (opts: {
        allAgents?: boolean;
        agentIds?: string[];
      }) => {
        const inv = await invites.create(companyId, dono.user.id, opts);
        const p = await auth.signup({
          name: 'P',
          email: email('p'),
          password: 'senha-forte',
        });
        await invites.accept(inv.code, p.user.id);
        return { userId: p.user.id, role: 'MEMBER' as const };
      };
      return { companyId, gerente, vendas, juridico, entrar };
    };
    const names = (list: { name: string }[]) => list.map((a) => a.name).sort();

    it('convite "todos os agentes": vê todos, inclusive os criados depois', async () => {
      const o = await orgComAgentes();
      const m = await o.entrar({ allAgents: true });
      expect(names(await agents.findAll(o.companyId, m))).toEqual([
        'Gerente',
        'Juridico',
        'Vendas',
      ]);
      await prisma.agent.create({
        data: {
          name: 'Novo',
          slug: `novo-${uid()}`,
          avatarSeed: 'x',
          companyId: o.companyId,
        },
      });
      expect(names(await agents.findAll(o.companyId, m))).toContain('Novo');
    });

    it('convite restrito: vê só os agentes escolhidos, sem o Gerente', async () => {
      const o = await orgComAgentes();
      const m = await o.entrar({ allAgents: false, agentIds: [o.vendas.id] });
      expect(names(await agents.findAll(o.companyId, m))).toEqual(['Vendas']);
      // sem agente escolhido, a mensagem vai para o primeiro liberado (não o Gerente)
      const def = await pickDefaultAgent(prisma, m.userId, o.companyId);
      expect(def?.id).toBe(o.vendas.id);
    });

    it('convite restrito exige agentes da própria org', async () => {
      const o = await orgComAgentes();
      const outra = await orgComAgentes();
      const dono = await prisma.membership.findFirstOrThrow({
        where: { companyId: o.companyId, role: 'OWNER' },
      });
      await expect(
        invites.create(o.companyId, dono.userId, {
          allAgents: false,
          agentIds: [outra.vendas.id],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        invites.create(o.companyId, dono.userId, {
          allAgents: false,
          agentIds: [],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('membro adicionado do jeito antigo segue com Gerente + liberados', async () => {
      const o = await orgComAgentes();
      const dono = await prisma.membership.findFirstOrThrow({
        where: { companyId: o.companyId, role: 'OWNER' },
      });
      const res = await users.invite(
        o.companyId,
        {
          userId: dono.userId,
          companyId: o.companyId,
          role: 'OWNER',
          email: 'x',
        } as any,
        'Antigo',
        email('antigo'),
      );
      const m = { userId: res.id, role: 'MEMBER' as const };
      expect(names(await agents.findAll(o.companyId, m))).toEqual(['Gerente']);
      await users.setAgentAccess(o.companyId, res.id, [o.juridico.id]);
      expect(names(await agents.findAll(o.companyId, m))).toEqual([
        'Gerente',
        'Juridico',
      ]);
      expect((await pickDefaultAgent(prisma, res.id, o.companyId))?.id).toBe(
        o.gerente.id,
      );
    });
  });
});
