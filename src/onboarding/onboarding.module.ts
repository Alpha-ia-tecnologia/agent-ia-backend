import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ProviderKeysModule } from '../provider-keys/provider-keys.module';
import { LlmClientService } from './llm-client.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [ProviderKeysModule, AgentsModule, ConversationsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, LlmClientService],
  exports: [LlmClientService],
})
export class OnboardingModule {}
