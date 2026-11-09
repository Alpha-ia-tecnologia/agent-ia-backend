import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateProviderKeyDto } from './dto/provider-key.dto';
import { ProviderKeysService } from './provider-keys.service';

@Controller('provider-keys')
export class ProviderKeysController {
  constructor(private readonly service: ProviderKeysService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProviderKeyDto) {
    return this.service.create(user.companyId, dto);
  }

  @Post(':id/test')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.test(user.companyId, id);
  }

  @Patch(':id/fallback')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setFallback(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: { priority: number },
  ) {
    return this.service.setFallbackPriority(
      user.companyId,
      id,
      dto.priority ?? 0,
    );
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }
}
