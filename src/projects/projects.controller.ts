import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateProjectDto,
  UpdateProjectDto,
  UpdateProjectStatusDto,
} from './dto/project.dto';
import { ProjectAnalysisService } from './project-analysis.service';
import { ProjectsService } from './projects.service';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly service: ProjectsService,
    private readonly analysis: ProjectAnalysisService,
    private readonly knowledge: KnowledgeService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.service.create(user.companyId, user.userId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.service.findAll(user.companyId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user.companyId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.service.update(user.companyId, id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProjectStatusDto,
  ) {
    return this.service.updateStatus(user.companyId, id, dto.status);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }

  @Post(':id/analyze')
  @HttpCode(202)
  analyze(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.analysis.start(user.companyId, id);
  }

  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Arquivo obrigatório');
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('Arquivo excede o limite de 20 MB');
    }
    await this.service.getOwned(user.companyId, id);
    return this.knowledge.upload(user.companyId, file, undefined, id);
  }

  @Get(':id/documents')
  async documents(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.service.getOwned(user.companyId, id);
    return this.prisma.knowledgeDocument.findMany({
      where: { companyId: user.companyId, projectId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        error: true,
        mimeType: true,
        chunkCount: true,
        createdAt: true,
      },
    });
  }
}
