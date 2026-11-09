import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Protege endpoints internos consumidos pelo bridge via header x-bridge-key. */
@Injectable()
export class BridgeKeyGuard implements CanActivate {
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.apiKey = (config.get<string>('BRIDGE_API_KEY') ?? '').trim();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const key = request.headers['x-bridge-key'];
    if (!this.apiKey || !key || key !== this.apiKey) {
      throw new UnauthorizedException('x-bridge-key inválida');
    }
    return true;
  }
}
