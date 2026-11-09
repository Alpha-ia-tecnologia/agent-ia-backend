import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { NO_ORG_KEY } from '../decorators/no-org.decorator';
import { membershipCache, membershipKey } from '../membership-cache';

const CACHE_MS = 30_000;

interface RequestUser {
  userId: string;
  companyId: string | null;
  role: UserRole | null;
}

/**
 * Organização ativa do token. O JWT diz qual org está ativa; o vínculo real
 * fica no banco — então quem foi removido perde o acesso mesmo com o token
 * antigo, e o papel do token é trocado pelo papel atual (promoção/rebaixamento
 * valem sem novo login). Roda antes do RolesGuard.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const noOrg = !!this.reflector.getAllAndOverride<boolean>(
      NO_ORG_KEY,
      targets,
    );
    const user = context
      .switchToHttp()
      .getRequest<{ user?: RequestUser }>().user;
    if (!user) return true; // sem usuário: o JwtAuthGuard já decidiu

    if (!user.companyId) {
      if (noOrg) return true;
      throw new ForbiddenException('Entre em uma organização ou crie a sua.');
    }

    const role = await this.currentRole(user.userId, user.companyId);
    if (!role) {
      if (noOrg) return true; // ex.: trocar para outra org depois de removido
      throw new ForbiddenException(
        'Você não faz mais parte desta organização.',
      );
    }
    user.role = role;
    return true;
  }

  private async currentRole(
    userId: string,
    companyId: string,
  ): Promise<UserRole | null> {
    const key = membershipKey(userId, companyId);
    const hit = membershipCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.role;
    const membership = await this.prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true },
    });
    const role = membership?.role ?? null;
    if (membershipCache.size > 50_000) membershipCache.clear();
    membershipCache.set(key, { role, expires: Date.now() + CACHE_MS });
    return role;
  }
}
