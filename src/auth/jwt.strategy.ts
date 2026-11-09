import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { UserRole } from '@prisma/client';
import type { AuthUser } from './decorators/current-user.decorator';

export interface JwtPayload {
  sub: string;
  /** organização ativa; null = conta sem organização ainda */
  companyId: string | null;
  role: UserRole | null;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      // Extractor de query param é necessário para o SSE: EventSource não envia headers.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthUser {
    return {
      userId: payload.sub,
      // Rotas comuns só rodam com organização ativa (OrgGuard); só as @NoOrg()
      // podem receber null aqui — elas tratam isso explicitamente.
      companyId: payload.companyId as string,
      role: payload.role as UserRole,
      email: payload.email,
    };
  }
}
