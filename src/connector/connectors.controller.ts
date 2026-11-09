import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ConnectorsService } from './connectors.service';

class PairDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  deviceName: string;
}

class CreateConnectorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;
}

@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly service: ConnectorsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.companyId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateConnectorDto) {
    return this.service.create(user.companyId, dto.name.trim());
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.revoke(user.companyId, id);
  }

  /** Código de uso único para parear o app desktop (mostrado no painel). */
  @Post('pair-code')
  pairCode(@CurrentUser() user: AuthUser) {
    return this.service.createPairCode(user.companyId);
  }

  /** Chamado PELO app desktop (sem JWT): troca o código pelo token. */
  @Post('pair')
  @Public()
  pair(@Body() dto: PairDto) {
    return this.service.pair(dto.code.trim(), dto.deviceName.trim());
  }
}
