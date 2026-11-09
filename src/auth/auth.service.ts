import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnboardingStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import IORedis, { type Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { DeleteAccountDto, LoginDto, SignupDto } from './dto/auth.dto';
import type { JwtPayload } from './jwt.strategy';

export interface OrgSummary {
  id: string;
  name: string;
  role: UserRole;
  onboardingStatus: OnboardingStatus;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole | null;
    companyId: string | null;
    companyName: string | null;
    onboardingStatus: OnboardingStatus | null;
  };
  orgs: OrgSummary[];
}

const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;

@Injectable()
export class AuthService implements OnModuleDestroy {
  // Tentativas erradas por e-mail (não por IP: num evento todos saem pelo
  // mesmo NAT, e um limite por IP travaria a sala inteira). No Redis vale
  // para todas as réplicas da api; sem Redis (ou com ele fora do ar) cai no
  // contador em memória — o login nunca fica preso no limitador.
  private readonly redis: Redis | null;
  private readonly loginFailures = new Map<
    string,
    { count: number; since: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const url = config.get<string>('REDIS_URL');
    this.redis = url
      ? new IORedis(url, {
          // comando falha na hora se o Redis cair, em vez de segurar o login
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        })
      : null;
    this.redis?.on('error', () => undefined);
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  private loginKey(email: string) {
    return email.trim().toLowerCase();
  }

  private redisKey(email: string) {
    return `aao:login-failures:${this.loginKey(email)}`;
  }

  private redisReady() {
    return this.redis?.status === 'ready';
  }

  private async loginFailureCount(email: string): Promise<number> {
    if (this.redisReady()) {
      try {
        return Number(await this.redis!.get(this.redisKey(email))) || 0;
      } catch {
        /* cai para a memória */
      }
    }
    const entry = this.loginFailures.get(this.loginKey(email));
    if (!entry) return 0;
    if (Date.now() - entry.since > LOGIN_WINDOW_MS) {
      this.loginFailures.delete(this.loginKey(email));
      return 0;
    }
    return entry.count;
  }

  private async assertLoginAllowed(email: string) {
    if ((await this.loginFailureCount(email)) >= MAX_LOGIN_FAILURES) {
      throw new HttpException(
        'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordLoginFailure(email: string) {
    if (this.redisReady()) {
      try {
        const key = this.redisKey(email);
        const count = await this.redis!.incr(key);
        // janela conta a partir do 1º erro (igual à versão em memória)
        if (count === 1) await this.redis!.pexpire(key, LOGIN_WINDOW_MS);
        return;
      } catch {
        /* cai para a memória */
      }
    }
    const key = this.loginKey(email);
    const now = Date.now();
    const entry = this.loginFailures.get(key);
    if (!entry || now - entry.since > LOGIN_WINDOW_MS) {
      // e-mails aleatórios não podem crescer o mapa sem fim
      if (this.loginFailures.size > 10_000) {
        for (const [k, v] of this.loginFailures) {
          if (now - v.since > LOGIN_WINDOW_MS) this.loginFailures.delete(k);
        }
      }
      this.loginFailures.set(key, { count: 1, since: now });
    } else {
      entry.count += 1;
    }
  }

  private async clearLoginFailures(email: string) {
    this.loginFailures.delete(this.loginKey(email));
    if (this.redisReady()) {
      await this.redis!.del(this.redisKey(email)).catch(() => undefined);
    }
  }

  async signup(dto: SignupDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('E-mail já cadastrado');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const companyName = dto.companyName?.trim();
    const userId = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: dto.email, passwordHash, name: dto.name },
      });
      if (companyName) {
        // fluxo de sempre: quem cria a organização é o dono
        const company = await tx.company.create({
          data: {
            name: companyName,
            businessDescription: dto.businessDescription,
            industry: dto.industry,
            // a organização do evento usa a trilha, sem o onboarding por IA
            onboardingStatus: OnboardingStatus.COMPLETED,
          },
        });
        await tx.membership.create({
          data: {
            userId: user.id,
            companyId: company.id,
            role: UserRole.OWNER,
          },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { companyId: company.id },
        });
      }
      return user.id;
    });
    return this.sessionFor(userId);
  }

  async login(dto: LoginDto) {
    await this.assertLoginAllowed(dto.email);
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, passwordHash: true },
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      await this.recordLoginFailure(dto.email);
      throw new UnauthorizedException('Credenciais inválidas');
    }
    await this.clearLoginFailures(dto.email);
    return this.sessionFor(user.id);
  }

  /** Troca a organização ativa (novo token). Só para quem é membro dela. */
  async switchOrg(userId: string, companyId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { id: true },
    });
    if (!membership) {
      throw new ForbiddenException('Você não faz parte desta organização.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { companyId },
    });
    return this.sessionFor(userId);
  }

  /**
   * Exclui a conta do usuário autenticado mediante confirmação de senha.
   * Organizações das quais ele é dono são apagadas junto (cascade em todos os
   * dados delas); nas demais, sai apenas o vínculo.
   */
  async deleteAccount(userId: string, dto: DeleteAccountDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Senha incorreta');
    }
    const owned = await this.prisma.membership.findMany({
      where: { userId, role: UserRole.OWNER },
      select: { companyId: true },
    });
    await this.prisma.$transaction([
      this.prisma.company.deleteMany({
        where: { id: { in: owned.map((m) => m.companyId) } },
      }),
      this.prisma.user.delete({ where: { id: userId } }),
    ]);
    return { deleted: true, scope: owned.length ? 'company' : 'user' };
  }

  /**
   * Resposta de sessão: token com a organização ativa (a última usada, se o
   * vínculo ainda existe; senão a mais antiga; senão nenhuma) e a lista de
   * organizações da pessoa.
   */
  async sessionFor(userId: string): Promise<AuthResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        companyId: true,
        memberships: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            company: {
              select: { id: true, name: true, onboardingStatus: true },
            },
          },
        },
      },
    });
    const orgs: OrgSummary[] = user.memberships.map((m) => ({
      id: m.company.id,
      name: m.company.name,
      role: m.role,
      onboardingStatus: m.company.onboardingStatus,
    }));
    const active = orgs.find((o) => o.id === user.companyId) ?? orgs[0] ?? null;
    const payload: JwtPayload = {
      sub: user.id,
      companyId: active?.id ?? null,
      role: active?.role ?? null,
      email: user.email,
    };
    return {
      token: this.jwt.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: active?.role ?? null,
        companyId: active?.id ?? null,
        companyName: active?.name ?? null,
        onboardingStatus: active?.onboardingStatus ?? null,
      },
      orgs,
    };
  }
}
