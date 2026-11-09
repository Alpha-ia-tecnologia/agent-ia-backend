import { Module } from '@nestjs/common';
import { ProviderKeysModule } from '../provider-keys/provider-keys.module';
import { StorageModule } from '../storage/storage.module';
import { ToolsModule } from '../tools/tools.module';
import { EmbeddingsService } from './embeddings.service';
import { InternalKnowledgeController } from './internal-knowledge.controller';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [StorageModule, ToolsModule, ProviderKeysModule],
  controllers: [KnowledgeController, InternalKnowledgeController],
  providers: [KnowledgeService, EmbeddingsService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
