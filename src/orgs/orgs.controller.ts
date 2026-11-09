import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { NoOrg } from '../auth/decorators/no-org.decorator';
import { CreateOrgDto } from './orgs.dto';
import { OrgsService } from './orgs.service';

@Controller('orgs')
@NoOrg()
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  /** Organizações das quais a pessoa faz parte (para o seletor). */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.orgs.listMine(user.userId);
  }

  /** Cria uma organização (a pessoa vira dona) e devolve a sessão nela. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgDto) {
    return this.orgs.create(user.userId, dto);
  }
}
