import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { ProviderKeysService } from './provider-keys.service';

/** Só leitura: a chave da IA é definida no servidor, não pela plataforma. */
@Controller('provider-keys')
export class ProviderKeysController {
  constructor(private readonly service: ProviderKeysService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.companyId);
  }
}
