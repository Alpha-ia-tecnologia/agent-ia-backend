import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import {
  AddTextDto,
  AddUrlDto,
  SetEmbeddingConfigDto,
} from './dto/knowledge.dto';
import { KnowledgeService } from './knowledge.service';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.companyId);
  }

  @Get('embeddings')
  embeddingConfig(@CurrentUser() user: AuthUser) {
    return this.service.embeddingStats(user.companyId);
  }

  @Patch('embeddings')
  setEmbeddingConfig(
    @CurrentUser() user: AuthUser,
    @Body() dto: SetEmbeddingConfigDto,
  ) {
    return this.service.setEmbeddingConfig(
      user.companyId,
      dto.keyId ?? null,
      dto.model ?? null,
    );
  }

  @Post('embeddings/reindex')
  reindex(@CurrentUser() user: AuthUser) {
    return this.service.reindex(user.companyId);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('agentId') agentId?: string,
  ) {
    if (!file) throw new BadRequestException('Arquivo obrigatório');
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('Arquivo excede o limite de 20 MB');
    }
    return this.service.upload(user.companyId, file, agentId || undefined);
  }

  @Post('text')
  addText(@CurrentUser() user: AuthUser, @Body() dto: AddTextDto) {
    return this.service.addText(
      user.companyId,
      dto.title,
      dto.content,
      dto.agentId || undefined,
    );
  }

  @Post('url')
  addUrl(@CurrentUser() user: AuthUser, @Body() dto: AddUrlDto) {
    return this.service.addUrl(
      user.companyId,
      dto.url,
      dto.agentId || undefined,
    );
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }
}
