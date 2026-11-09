import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export interface AuthUser {
  userId: string;
  companyId: string;
  role: UserRole;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return request.user;
  },
);
