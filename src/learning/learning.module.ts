import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { LearningController } from './learning.controller';

@Module({
  imports: [ConversationsModule],
  controllers: [LearningController],
})
export class LearningModule {}
