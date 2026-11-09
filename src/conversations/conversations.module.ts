import { Module, forwardRef } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DatasetsModule } from '../datasets/datasets.module';
import { ConnectorModule } from '../connector/connector.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProviderKeysModule } from '../provider-keys/provider-keys.module';
import { ToolsModule } from '../tools/tools.module';
import { BridgeService } from './bridge.service';
import { ConversationStreamService } from './conversation-stream.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { InternalConversationsController } from './internal-conversations.controller';

@Module({
  imports: [
    ProviderKeysModule,
    ToolsModule,
    KnowledgeModule,
    ConnectorModule,
    DatasetsModule,
    forwardRef(() => ChannelsModule),
  ],
  controllers: [ConversationsController, InternalConversationsController],
  providers: [ConversationsService, BridgeService, ConversationStreamService],
  exports: [BridgeService, ConversationsService],
})
export class ConversationsModule {}
