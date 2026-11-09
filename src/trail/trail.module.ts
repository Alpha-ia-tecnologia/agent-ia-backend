import { Module } from '@nestjs/common';
import { ProviderKeysModule } from '../provider-keys/provider-keys.module';
import { TrailActivityService } from './trail-activity.service';
import { TrailAgentsService } from './trail-agents.service';
import { TrailAiService } from './trail-ai.service';
import { TrailController } from './trail.controller';
import { TrailService } from './trail.service';

@Module({
  imports: [ProviderKeysModule],
  controllers: [TrailController],
  providers: [
    TrailService,
    TrailAiService,
    TrailAgentsService,
    TrailActivityService,
  ],
  exports: [TrailService],
})
export class TrailModule {}
