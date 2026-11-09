import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { DatasetsService } from './datasets.service';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

@Controller('datasets')
export class DatasetsController {
  constructor(private readonly service: DatasetsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.companyId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.get(user.companyId, id);
  }

  @Get(':id/rows')
  rows(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.rows(
      user.companyId,
      id,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name?: string,
    @Body('description') description?: string,
  ) {
    if (!file) throw new BadRequestException('Arquivo obrigatório');
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('Arquivo excede o limite de 20 MB');
    }
    return this.service.createFromFile(user.companyId, file, name, description);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: { name?: string; description?: string },
  ) {
    return this.service.update(user.companyId, id, dto);
  }

  @Patch(':id/columns/:columnId')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  updateColumn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('columnId') columnId: string,
    @Body() dto: { type?: string; description?: string },
  ) {
    return this.service.updateColumn(user.companyId, id, columnId, dto);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }
}
